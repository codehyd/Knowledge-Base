from __future__ import annotations

import re
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.knowledge.models import Category, Entry, EntryAnnotation, EntryCategory
from app.modules.knowledge.schemas import (
    AnnotationCreate,
    AnnotationExpandIn,
    AnnotationListOut,
    AnnotationOut,
    AnnotationPromoteIn,
    AnnotationUpdate,
    BookshelfItemOut,
    BookshelfListOut,
    CategoryCreate,
    CategoryListOut,
    CategoryOut,
    CategoryUpdate,
    CollectionListOut,
    CollectionOut,
    EntryBatchAddDomainIn,
    EntryBatchAddDomainOut,
    EntryCategoriesIn,
    EntryDetailOut,
    EntryListItem,
    EntryListOut,
    EntryPreviewOut,
    MediaItemOut,
    MediaListOut,
    anchor_note_from_label,
    label_from_anchor_note,
    merge_point_labels,
    normalize_ann_color,
    pick_chat_anchor_color,
)
from app.modules.knowledge.index import read_entry_text
from app.modules.knowledge.passage import ranges_same_passage, step_expand, step_shrink
from app.modules.sources.classify import is_good_tag
from app.modules.sources.models import Source
from app.modules.sources.preview_search import search_text_hits
from app.modules.sources.schemas import PreviewSearchOut
from app.modules.sources.service import PREVIEW_DEFAULT_LIMIT, sources_service

# service.py → knowledge → modules → app → api → apps → 仓库根
_REPO_ROOT = Path(__file__).resolve().parents[5]
PREVIEW_CHARS = 4000
MEDIA_TYPES = ("video_url", "video_file", "url")
BOOK_TYPES = ("ebook",)


def _data_root() -> Path:
    settings = get_settings()
    root = Path(settings.data_dir)
    if not root.is_absolute():
        root = _REPO_ROOT / root
    return root


class KnowledgeService:
    async def _sources_for_entries(
        self, db: AsyncSession, entry_rows: list[Entry]
    ) -> dict[int, Source]:
        ids = [int(r.source_id) for r in entry_rows if r.source_id]
        if not ids:
            return {}
        result = await db.execute(select(Source).where(Source.id.in_(ids)))
        return {int(s.id): s for s in result.scalars().all()}

    def _entry_list_item(
        self,
        row: Entry,
        labels: dict[int, dict[str, list]],
        sources: dict[int, Source],
    ) -> EntryListItem:
        src = sources.get(int(row.source_id)) if row.source_id else None
        lab = labels.get(row.id) or {}
        return EntryListItem(
            id=row.id,
            title=row.title,
            summary=row.summary,
            source_id=row.source_id,
            source_type=(src.type if src else "") or "",
            source_uri=(src.source_uri if src else "") or "",
            in_vault=bool(src and (getattr(src, "vault_path", None) or "").strip()),
            categories=list(lab.get("categories") or []),
            category_ids=list(lab.get("category_ids") or []),
            tags=list(lab.get("tags") or []),
            collection_title=(getattr(src, "collection_title", None) or "").strip()
            if src
            else "",
            episode_no=int(getattr(src, "episode_no", 0) or 0) if src else 0,
            created_at=row.created_at,
        )

    async def _ensure_collection_category_links(self, db: AsyncSession) -> None:
        """补齐合集名分类与分集挂靠（历史数据可能被低质量标签清理误删）。"""
        # 先尝试把孤儿条目挂回同标题/同合集分集的已存在来源
        await self._relink_orphan_entries(db)
        rows = (
            await db.execute(
                select(Entry.id, Source.collection_title)
                .join(Source, Source.id == Entry.source_id)
                .where(
                    Source.collection_title.is_not(None),
                    Source.collection_title != "",
                )
            )
        ).all()
        if not rows:
            return

        titles = sorted({(t or "").strip()[:100] for _, t in rows if (t or "").strip()})
        existing = {
            (c.name or "").strip(): c
            for c in (
                await db.execute(select(Category).where(Category.name.in_(titles)))
            ).scalars().all()
        }
        changed = False
        for title in titles:
            if title not in existing:
                cat = Category(name=title, kind="tag", parent_id=None)
                db.add(cat)
                await db.flush()
                existing[title] = cat
                changed = True

        for entry_id, raw_title in rows:
            title = (raw_title or "").strip()[:100]
            if not title:
                continue
            cat = existing.get(title)
            if not cat:
                continue
            linked = await db.execute(
                select(EntryCategory).where(
                    EntryCategory.entry_id == int(entry_id),
                    EntryCategory.category_id == int(cat.id),
                )
            )
            if linked.scalar_one_or_none() is None:
                db.add(EntryCategory(entry_id=int(entry_id), category_id=int(cat.id)))
                changed = True
        if changed:
            await db.commit()

    async def _relink_orphan_entries(self, db: AsyncSession) -> int:
        """条目 source_id 已无对应来源时，按 title_key / 标题挂回仍存在的来源。"""
        from app.modules.sources.classify import normalize_title_key

        entries = (await db.execute(select(Entry).where(Entry.source_id.is_not(None)))).scalars().all()
        fixed = 0
        for entry in entries:
            sid = entry.source_id
            if sid is None:
                continue
            src = await db.get(Source, sid)
            if src is not None:
                continue
            # 孤儿：优先按 title_key 找 ready/committed 来源
            key = (entry.title_key or "").strip() or normalize_title_key(entry.title or "")
            candidate = None
            if key:
                rows = (
                    await db.execute(
                        select(Source).where(
                            Source.status.in_(["ready", "committed", "ingesting"])
                        )
                    )
                ).scalars().all()
                for s in rows:
                    if normalize_title_key(s.title or s.filename or "") == key:
                        # 该来源尚无条目才挂
                        has = (
                            await db.execute(
                                select(Entry.id).where(Entry.source_id == s.id).limit(1)
                            )
                        ).scalar_one_or_none()
                        if has is None:
                            candidate = s
                            break
            if candidate is None:
                continue
            entry.source_id = candidate.id
            if candidate.status != "committed":
                candidate.status = "committed"
                candidate.stage = "committed"
                candidate.progress = 100
                candidate.error_message = ""
            fixed += 1
        if fixed:
            await db.commit()
        return fixed
    async def list_collections(self, db: AsyncSession) -> CollectionListOut:
        """已入库视频合集：按 Source.collection_title 聚合，供侧栏文件夹展示。"""
        await self._ensure_collection_category_links(db)
        result = await db.execute(
            select(
                Source.collection_title,
                func.count(Entry.id),
                func.max(Source.episode_no),
            )
            .join(Entry, Entry.source_id == Source.id)
            .where(
                Source.collection_title.is_not(None),
                Source.collection_title != "",
            )
            .group_by(Source.collection_title)
            .order_by(Source.collection_title)
        )
        items: list[CollectionOut] = []
        for title, count, max_ep in result.all():
            name = (title or "").strip()
            if not name:
                continue
            items.append(
                CollectionOut(
                    title=name,
                    count=int(count or 0),
                    episode_total=int(max_ep or 0),
                )
            )
        return CollectionListOut(items=items)

    async def _labels_for_entries(
        self, db: AsyncSession, entry_ids: list[int]
    ) -> dict[int, dict[str, list]]:
        """拆分人工分类与自动标签。"""
        if not entry_ids:
            return {}
        result = await db.execute(
            select(EntryCategory.entry_id, Category.id, Category.name, Category.kind)
            .join(Category, Category.id == EntryCategory.category_id)
            .where(EntryCategory.entry_id.in_(entry_ids))
            .order_by(Category.name)
        )
        mapping: dict[int, dict[str, list]] = {
            eid: {"categories": [], "category_ids": [], "tags": []} for eid in entry_ids
        }
        for entry_id, cat_id, name, kind in result.all():
            bucket = mapping.setdefault(
                int(entry_id), {"categories": [], "category_ids": [], "tags": []}
            )
            kind_norm = (kind or "tag").strip().lower()
            if kind_norm == "domain":
                bucket["categories"].append(name or "")
                bucket["category_ids"].append(int(cat_id))
            else:
                bucket["tags"].append(name or "")
        return mapping

    async def _categories_for_entries(
        self, db: AsyncSession, entry_ids: list[int]
    ) -> dict[int, list[str]]:
        """兼容旧调用：返回全部关联名（分类+标签）。"""
        labels = await self._labels_for_entries(db, entry_ids)
        return {
            eid: list(lab.get("categories") or []) + list(lab.get("tags") or [])
            for eid, lab in labels.items()
        }

    @staticmethod
    def _cat_kind(row: Category) -> str:
        kind = (getattr(row, "kind", None) or "tag").strip().lower()
        return kind if kind in {"domain", "tag"} else "tag"

    async def list_categories(self, db: AsyncSession) -> CategoryListOut:
        total_entries = int(
            (await db.execute(select(func.count()).select_from(Entry))).scalar_one()
        )
        # 清掉英文书名碎片（The/and/Forest）与空主题标签；用户顶级域保留
        await self._prune_low_quality_categories(db)
        await self._prune_empty_categories(db)

        tag_counts = {
            int(cid): int(cnt or 0)
            for cid, cnt in (
                await db.execute(
                    select(EntryCategory.category_id, func.count(EntryCategory.entry_id))
                    .group_by(EntryCategory.category_id)
                )
            ).all()
        }

        rows = list((await db.execute(select(Category).order_by(Category.name))).scalars().all())
        # 人工分类计数 = 直接挂到该 domain 的条目数（不再汇总子标签）
        items: list[CategoryOut] = []
        for row in rows:
            kind = self._cat_kind(row)
            parent_id = getattr(row, "parent_id", None)
            count = tag_counts.get(int(row.id), 0)
            if kind == "domain":
                parent_id = None
            items.append(
                CategoryOut(
                    id=int(row.id),
                    name=row.name or "",
                    count=count,
                    kind=kind,
                    parent_id=int(parent_id) if parent_id is not None else None,
                )
            )
        # 域在前，再按名称
        items.sort(key=lambda c: (0 if c.kind == "domain" else 1, c.name))
        return CategoryListOut(items=items, total_entries=total_entries)

    async def create_domain(self, db: AsyncSession, payload: CategoryCreate) -> CategoryOut:
        name = re.sub(r"\s+", " ", (payload.name or "").strip())
        if not name:
            raise HTTPException(status_code=400, detail="请填写顶级分类名称")
        if len(name) > 100:
            raise HTTPException(status_code=400, detail="名称过长")
        exists = await db.execute(select(Category).where(Category.name == name))
        if exists.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="已有同名分类")
        row = Category(name=name, kind="domain", parent_id=None)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return CategoryOut(id=row.id, name=row.name, count=0, kind="domain", parent_id=None)

    async def update_category(
        self, db: AsyncSession, category_id: int, payload: CategoryUpdate
    ) -> CategoryOut:
        row = await db.get(Category, category_id)
        if not row:
            raise HTTPException(status_code=404, detail="分类不存在")
        kind = self._cat_kind(row)

        if payload.name is not None:
            name = re.sub(r"\s+", " ", payload.name.strip())
            if not name:
                raise HTTPException(status_code=400, detail="名称不能为空")
            clash = await db.execute(
                select(Category).where(Category.name == name, Category.id != category_id)
            )
            if clash.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="已有同名分类")
            row.name = name

        # parent_id：仅主题标签可挂到顶级域；显式传 null 取消挂靠
        fields_set = getattr(payload, "model_fields_set", None) or getattr(
            payload, "__fields_set__", set()
        )
        if "parent_id" in fields_set:
            if kind == "domain":
                raise HTTPException(status_code=400, detail="顶级分类不能再挂到其他分类下")
            parent_id = payload.parent_id
            if parent_id is None:
                row.parent_id = None
            else:
                parent = await db.get(Category, int(parent_id))
                if not parent or self._cat_kind(parent) != "domain":
                    raise HTTPException(status_code=400, detail="只能挂到用户顶级分类下")
                if int(parent.id) == int(row.id):
                    raise HTTPException(status_code=400, detail="不能挂到自己")
                row.parent_id = int(parent.id)

        await db.commit()
        await db.refresh(row)
        # 复用列表计数逻辑的简化版
        listing = await self.list_categories(db)
        for item in listing.items:
            if item.id == row.id:
                return item
        return CategoryOut(
            id=row.id,
            name=row.name or "",
            count=0,
            kind=self._cat_kind(row),
            parent_id=getattr(row, "parent_id", None),
        )

    async def delete_domain(self, db: AsyncSession, category_id: int) -> None:
        row = await db.get(Category, category_id)
        if not row:
            raise HTTPException(status_code=404, detail="分类不存在")
        if self._cat_kind(row) != "domain":
            raise HTTPException(status_code=400, detail="只能删除用户顶级分类")
        # 子标签解除挂靠，不删主题标签本身
        children = await db.execute(
            select(Category).where(Category.parent_id == category_id)
        )
        for child in children.scalars().all():
            child.parent_id = None
        await db.delete(row)
        await db.commit()

    async def _collection_titles(self, db: AsyncSession) -> set[str]:
        result = await db.execute(
            select(Source.collection_title)
            .where(
                Source.collection_title.is_not(None),
                Source.collection_title != "",
            )
            .distinct()
        )
        return {(t or "").strip() for t in result.scalars().all() if (t or "").strip()}

    async def _prune_low_quality_categories(self, db: AsyncSession) -> None:
        """拆除低质量标签挂靠并删除分类（书名英文切片、口号标题等）。

        视频合集名通常很长、带括号，会误伤 is_good_tag；必须保留，否则合集芯片有数、列表为空。
        """
        protected = await self._collection_titles(db)
        result = await db.execute(select(Category))
        cats = list(result.scalars().all())
        removed = False
        for cat in cats:
            if self._cat_kind(cat) == "domain":
                continue
            name = (cat.name or "").strip()
            if name in protected:
                continue
            if is_good_tag(name):
                continue
            links = await db.execute(
                select(EntryCategory).where(EntryCategory.category_id == cat.id)
            )
            for link in links.scalars().all():
                await db.delete(link)
            await db.delete(cat)
            removed = True
        if removed:
            await db.commit()

    async def _prune_empty_categories(self, db: AsyncSession) -> None:
        used = select(EntryCategory.category_id).distinct()
        result = await db.execute(select(Category).where(Category.id.not_in(used)))
        orphans = list(result.scalars().all())
        if not orphans:
            return
        removed = False
        for cat in orphans:
            if self._cat_kind(cat) == "domain":
                continue  # 用户顶级域即使暂时无条目也保留
            await db.delete(cat)
            removed = True
        if removed:
            await db.commit()

    async def list_entries(
        self,
        db: AsyncSession,
        *,
        q: str = "",
        category: str = "",
        kind: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> EntryListOut:
        page = max(1, page)
        page_size = min(max(1, page_size), 500)
        kind_norm = (kind or "").strip().lower()
        cat_name = category.strip()

        stmt = select(Entry)
        count_stmt = select(func.count()).select_from(Entry)
        source_joined = False

        if kind_norm in {"book", "media", "note"}:
            stmt = stmt.join(Source, Source.id == Entry.source_id)
            count_stmt = count_stmt.join(Source, Source.id == Entry.source_id)
            source_joined = True
            if kind_norm == "book":
                stmt = stmt.where(Source.type.in_(BOOK_TYPES))
                count_stmt = count_stmt.where(Source.type.in_(BOOK_TYPES))
            elif kind_norm == "media":
                stmt = stmt.where(Source.type.in_(MEDIA_TYPES))
                count_stmt = count_stmt.where(Source.type.in_(MEDIA_TYPES))
            else:
                stmt = stmt.where(Source.type == "note")
                count_stmt = count_stmt.where(Source.type == "note")

        # 合集名可能因「低质量标签清理」丢掉 Category 挂靠；优先按 Source.collection_title 收拢
        is_collection = False
        if cat_name:
            col_cnt = int(
                (
                    await db.execute(
                        select(func.count())
                        .select_from(Source)
                        .where(Source.collection_title == cat_name)
                    )
                ).scalar_one()
            )
            is_collection = col_cnt > 0

        if cat_name and is_collection:
            if not source_joined:
                stmt = stmt.join(Source, Source.id == Entry.source_id)
                count_stmt = count_stmt.join(Source, Source.id == Entry.source_id)
                source_joined = True
            stmt = stmt.where(Source.collection_title == cat_name)
            count_stmt = count_stmt.where(Source.collection_title == cat_name)
        elif cat_name:
            # 按名过滤：domain / tag 均只匹配直接挂靠该 Category 的条目
            cat_filter = (
                select(EntryCategory.entry_id)
                .join(Category, Category.id == EntryCategory.category_id)
                .where(Category.name == cat_name)
            )
            stmt = stmt.where(Entry.id.in_(cat_filter))
            count_stmt = count_stmt.where(Entry.id.in_(cat_filter))

        keyword = q.strip()
        if keyword:
            like = f"%{keyword}%"
            cond = or_(Entry.title.ilike(like), Entry.summary.ilike(like))
            stmt = stmt.where(cond)
            count_stmt = count_stmt.where(cond)

        total = int((await db.execute(count_stmt)).scalar_one())
        # 合集分集：按 episode_no 升序，便于「文件夹」内按讲次浏览
        if cat_name and is_collection:
            if not source_joined:
                stmt = stmt.join(Source, Source.id == Entry.source_id)
            order = (
                func.coalesce(Source.episode_no, 0).asc(),
                desc(Entry.created_at),
            )
        elif cat_name:
            if not source_joined:
                stmt = stmt.outerjoin(Source, Source.id == Entry.source_id)
            order = (
                func.coalesce(Source.episode_no, 0).asc(),
                desc(Entry.created_at),
            )
        else:
            order = (desc(Entry.created_at),)
        result = await db.execute(
            stmt.order_by(*order)
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        rows = list(result.scalars().all())
        labels = await self._labels_for_entries(db, [r.id for r in rows])
        sources = await self._sources_for_entries(db, rows)
        items = [self._entry_list_item(r, labels, sources) for r in rows]
        return EntryListOut(items=items, total=total, page=page, page_size=page_size)

    async def list_media(self, db: AsyncSession) -> MediaListOut:
        """视频 / 网页链接：含已抽取待入库与已入库。"""
        result = await db.execute(
            select(Source)
            .where(
                Source.type.in_(MEDIA_TYPES),
                Source.status.in_(("ready", "committed")),
            )
            .order_by(
                Source.collection_title.asc(),
                func.coalesce(Source.episode_no, 0).asc(),
                desc(Source.created_at),
            )
        )
        sources = list(result.scalars().all())
        if not sources:
            return MediaListOut(items=[], total=0)

        source_ids = [s.id for s in sources]
        entry_rows = (
            await db.execute(
                select(Entry.id, Entry.source_id)
                .where(Entry.source_id.in_(source_ids))
                .order_by(desc(Entry.created_at))
            )
        ).all()
        entry_by_source: dict[int, int] = {}
        for entry_id, source_id in entry_rows:
            if source_id is None:
                continue
            if source_id not in entry_by_source:
                entry_by_source[source_id] = int(entry_id)

        items: list[MediaItemOut] = []
        for src in sources:
            items.append(
                MediaItemOut(
                    source_id=src.id,
                    entry_id=entry_by_source.get(src.id),
                    title=(src.title or src.source_uri or f"媒体 #{src.id}").strip()[:500],
                    source_uri=src.source_uri or "",
                    media_type=src.type or "",
                    status=src.status or "",
                    char_count=int(src.char_count or 0),
                    has_follow_along=sources_service.follow_along_ready(src.id),
                    collection_title=(src.collection_title or "").strip(),
                    episode_no=int(src.episode_no or 0),
                    created_at=src.created_at,
                )
            )
        return MediaListOut(items=items, total=len(items))

    async def list_bookshelf(self, db: AsyncSession) -> BookshelfListOut:
        """确认书籍书架：仅 book_kind=confirmed；含已抽取/已入库。"""
        result = await db.execute(
            select(Source)
            .where(
                Source.type == "ebook",
                Source.book_kind == "confirmed",
                Source.status.in_(("ready", "committed")),
            )
            .order_by(desc(Source.created_at))
        )
        sources = list(result.scalars().all())
        if not sources:
            return BookshelfListOut(items=[], total=0)

        source_ids = [s.id for s in sources]
        entry_rows = (
            await db.execute(
                select(Entry.id, Entry.source_id)
                .where(Entry.source_id.in_(source_ids))
                .order_by(desc(Entry.created_at))
            )
        ).all()
        entry_by_source: dict[int, int] = {}
        for entry_id, source_id in entry_rows:
            if source_id is None:
                continue
            # 同一来源取最新一条条目
            if source_id not in entry_by_source:
                entry_by_source[source_id] = int(entry_id)

        items: list[BookshelfItemOut] = []
        for src in sources:
            suffix = Path(src.filename or "").suffix.lower().lstrip(".")
            items.append(
                BookshelfItemOut(
                    source_id=src.id,
                    entry_id=entry_by_source.get(src.id),
                    title=(src.title or Path(src.filename or "").stem or f"书 #{src.id}"),
                    filename=src.filename or "",
                    format=suffix,
                    provenance=src.provenance or "upload",
                    book_kind=src.book_kind or "confirmed",
                    status=src.status or "",
                    char_count=int(src.char_count or 0),
                    created_at=src.created_at,
                )
            )
        return BookshelfListOut(items=items, total=len(items))

    async def get_entry(self, db: AsyncSession, entry_id: int) -> EntryDetailOut:
        row = await db.get(Entry, entry_id)
        if not row:
            raise HTTPException(status_code=404, detail="条目不存在")

        labels = await self._labels_for_entries(db, [row.id])
        lab = labels.get(row.id) or {}
        preview = ""
        preview_truncated = False
        char_count = 0
        source_filename = ""
        source_type = ""
        source_uri = ""
        in_vault = False
        has_follow_along = False
        if row.source_id:
            source = await db.get(Source, row.source_id)
            if source:
                source_filename = source.filename or ""
                source_type = source.type or ""
                source_uri = source.source_uri or ""
                in_vault = bool((getattr(source, "vault_path", None) or "").strip())
                if source.type in {"video_url", "video_file"}:
                    has_follow_along = sources_service.follow_along_ready(int(row.source_id))
                if source.text_path:
                    path = _data_root() / source.text_path
                    if path.is_file():
                        text = path.read_text(encoding="utf-8")
                        char_count = len(text)
                        preview = text[:PREVIEW_CHARS]
                        preview_truncated = len(text) > PREVIEW_CHARS
                        if preview_truncated:
                            preview = preview.rstrip() + "…"

        return EntryDetailOut(
            id=row.id,
            title=row.title,
            summary=row.summary,
            source_id=row.source_id,
            categories=list(lab.get("categories") or []),
            category_ids=list(lab.get("category_ids") or []),
            tags=list(lab.get("tags") or []),
            created_at=row.created_at,
            preview=preview or row.summary,
            preview_truncated=preview_truncated,
            char_count=char_count or len(row.summary or ""),
            source_filename=source_filename,
            source_type=source_type,
            source_uri=source_uri,
            in_vault=in_vault,
            has_follow_along=has_follow_along,
        )

    async def set_entry_categories(
        self, db: AsyncSession, entry_id: int, payload: EntryCategoriesIn
    ) -> EntryDetailOut:
        row = await db.get(Entry, entry_id)
        if not row:
            raise HTTPException(status_code=404, detail="条目不存在")

        wanted_ids = sorted({int(x) for x in (payload.category_ids or []) if int(x) > 0})
        if wanted_ids:
            found = list(
                (
                    await db.execute(select(Category).where(Category.id.in_(wanted_ids)))
                ).scalars().all()
            )
            if len(found) != len(wanted_ids):
                raise HTTPException(status_code=400, detail="存在无效的分类")
            for cat in found:
                if self._cat_kind(cat) != "domain":
                    raise HTTPException(
                        status_code=400, detail="只能挂靠人工分类，不能把自动标签当作分类"
                    )

        # 仅替换 domain 关联；tag 关联原样保留
        existing = list(
            (
                await db.execute(
                    select(EntryCategory, Category)
                    .join(Category, Category.id == EntryCategory.category_id)
                    .where(EntryCategory.entry_id == entry_id)
                )
            ).all()
        )
        for link, cat in existing:
            if self._cat_kind(cat) == "domain":
                await db.delete(link)

        for cid in wanted_ids:
            db.add(EntryCategory(entry_id=entry_id, category_id=cid))

        await db.commit()
        return await self.get_entry(db, entry_id)

    async def batch_add_domain(
        self, db: AsyncSession, payload: EntryBatchAddDomainIn
    ) -> EntryBatchAddDomainOut:
        """批量追加人工分类；已挂靠的跳过。"""
        cat = await db.get(Category, int(payload.category_id))
        if not cat:
            raise HTTPException(status_code=404, detail="分类不存在")
        if self._cat_kind(cat) != "domain":
            raise HTTPException(
                status_code=400, detail="只能挂靠人工分类，不能把自动标签当作分类"
            )

        ids = [int(x) for x in (payload.entry_ids or []) if int(x) > 0]
        title = (payload.collection_title or "").strip()
        if not ids and title:
            rows = (
                await db.execute(
                    select(Entry.id)
                    .join(Source, Entry.source_id == Source.id)
                    .where(Source.collection_title == title)
                    .order_by(Entry.id.asc())
                )
            ).all()
            ids = [int(i) for (i,) in rows]
        if not ids:
            raise HTTPException(
                status_code=400, detail="请选择条目，或提供有效的合集名"
            )

        # 去重保序
        seen: set[int] = set()
        ordered: list[int] = []
        for eid in ids:
            if eid in seen:
                continue
            seen.add(eid)
            ordered.append(eid)

        updated = 0
        skipped = 0
        for eid in ordered:
            entry = await db.get(Entry, eid)
            if not entry:
                skipped += 1
                continue
            linked = (
                await db.execute(
                    select(EntryCategory).where(
                        EntryCategory.entry_id == eid,
                        EntryCategory.category_id == cat.id,
                    )
                )
            ).scalar_one_or_none()
            if linked is not None:
                skipped += 1
                continue
            db.add(EntryCategory(entry_id=eid, category_id=cat.id))
            updated += 1
        if updated:
            await db.commit()
        return EntryBatchAddDomainOut(
            updated=updated, skipped=skipped, total=len(ordered)
        )

    async def get_preview(
        self,
        db: AsyncSession,
        entry_id: int,
        *,
        offset: int = 0,
        limit: int = PREVIEW_DEFAULT_LIMIT,
    ) -> EntryPreviewOut:
        row = await db.get(Entry, entry_id)
        if not row:
            raise HTTPException(status_code=404, detail="条目不存在")

        offset = max(0, offset)
        limit = min(max(1, limit), 50000)
        title = row.title or f"条目 #{row.id}"

        # 优先走关联来源；来源被清空队列删掉时，仍尝试读 uploads/{id}/extracted.txt
        if row.source_id:
            try:
                src = await sources_service.get_preview(
                    db, row.source_id, offset=offset, limit=limit
                )
                return EntryPreviewOut(
                    entry_id=row.id,
                    source_id=row.source_id,
                    title=row.title or src.title,
                    char_count=src.char_count,
                    text=src.text,
                    offset=src.offset,
                    limit=src.limit,
                    truncated=src.truncated,
                )
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                orphan = _data_root() / "uploads" / str(row.source_id) / "extracted.txt"
                if orphan.is_file():
                    text = orphan.read_text(encoding="utf-8")
                    chunk = text[offset : offset + limit]
                    return EntryPreviewOut(
                        entry_id=row.id,
                        source_id=row.source_id,
                        title=title,
                        char_count=len(text),
                        text=chunk,
                        offset=offset,
                        limit=limit,
                        truncated=offset + len(chunk) < len(text),
                    )

        summary = row.summary or ""
        chunk = summary[offset : offset + limit]
        return EntryPreviewOut(
            entry_id=row.id,
            source_id=row.source_id,
            title=title,
            char_count=len(summary),
            text=chunk,
            offset=offset,
            limit=limit,
            truncated=offset + len(chunk) < len(summary),
        )

    def _read_entry_full_text(self, row: Entry) -> str:
        if row.source_id:
            orphan = _data_root() / "uploads" / str(row.source_id) / "extracted.txt"
            if orphan.is_file():
                return orphan.read_text(encoding="utf-8")
        return row.summary or ""

    async def search_preview(
        self,
        db: AsyncSession,
        entry_id: int,
        *,
        query: str,
        offset: int = 0,
        limit: int = 100,
    ) -> PreviewSearchOut:
        row = await db.get(Entry, entry_id)
        if not row:
            raise HTTPException(status_code=404, detail="条目不存在")
        q = (query or "").strip()
        if not q:
            raise HTTPException(status_code=400, detail="请输入搜索词")
        if len(q) > 120:
            raise HTTPException(status_code=400, detail="搜索词过长")

        if row.source_id:
            try:
                return await sources_service.search_preview(
                    db, row.source_id, query=q, offset=offset, limit=limit
                )
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise

        text = self._read_entry_full_text(row)
        offset = max(0, offset)
        limit = min(max(1, limit), 500)
        hits, total = search_text_hits(text, q, offset=offset, limit=limit)
        return PreviewSearchOut(
            query=q, total=total, offset=offset, limit=limit, hits=hits
        )

    async def delete_entry(self, db: AsyncSession, entry_id: int) -> None:
        row = await db.get(Entry, entry_id)
        if not row:
            raise HTTPException(status_code=404, detail="条目不存在")
        await self._delete_entry_row(db, row)
        await db.commit()
        await self._prune_empty_categories(db)

    async def _delete_entry_row(self, db: AsyncSession, row: Entry) -> None:
        """删除单条 Entry（不 commit），供批量删除复用。"""
        source_id = row.source_id
        source = await db.get(Source, source_id) if source_id else None

        # 笔记库中的手写笔记：与笔记页删除统一（来源 + 条目 + .md/.lake + uploads）
        if (
            source
            and (source.type or "") == "note"
            and (getattr(source, "vault_path", None) or "").strip()
        ):
            from app.modules.vault.service import vault_service

            await vault_service.delete_note(db, int(source.id))
            return

        links = await db.execute(
            select(EntryCategory).where(EntryCategory.entry_id == row.id)
        )
        for link in links.scalars().all():
            await db.delete(link)
        await db.delete(row)

        # 入库错了时：删条目后将来源恢复为 ready，便于重新入库
        if source and source.status == "committed":
            source.status = "ready"
            source.stage = "extracted"
            source.progress = 100
            source.error_message = ""

    async def delete_entries_batch(
        self, db: AsyncSession, entry_ids: list[int]
    ) -> int:
        """批量删除知识条目；返回实际删除数。"""
        seen: set[int] = set()
        removed = 0
        for raw_id in entry_ids:
            eid = int(raw_id)
            if eid <= 0 or eid in seen:
                continue
            seen.add(eid)
            row = await db.get(Entry, eid)
            if not row:
                continue
            await self._delete_entry_row(db, row)
            removed += 1
        if removed:
            await db.commit()
            await self._prune_empty_categories(db)
        return removed

    async def delete_collection(self, db: AsyncSession, title: str) -> int:
        """删除合集下全部已入库分集条目。"""
        name = (title or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="合集名不能为空")
        result = await db.execute(
            select(Entry.id)
            .join(Source, Entry.source_id == Source.id)
            .where(Source.collection_title == name)
            .order_by(Entry.id.asc())
        )
        ids = [int(i) for (i,) in result.all()]
        if not ids:
            raise HTTPException(status_code=404, detail="未找到该合集的已入库分集")
        return await self.delete_entries_batch(db, ids)

    def _ann_out(self, row: EntryAnnotation) -> AnnotationOut:
        kind = (getattr(row, "kind", None) or "").strip().lower()
        if not kind:
            kind = "chat_anchor" if (row.note or "").startswith("对话引用") else "note"
        page = getattr(row, "page", None)
        data = {
            "id": row.id,
            "entry_id": row.entry_id,
            "start_offset": row.start_offset,
            "end_offset": row.end_offset,
            "quote": row.quote or "",
            "note": row.note or "",
            "kind": kind if kind in {"note", "chat_anchor"} else "note",
            "color": row.color or "#facc15",
            "page": int(page) if page is not None else None,
            "rect_json": (getattr(row, "rect_json", None) or "") or "",
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
        return AnnotationOut.model_validate(data)

    async def _next_chat_anchor_color(
        self,
        db: AsyncSession,
        entry_id: int,
        *,
        exclude_id: int | None = None,
    ) -> str:
        """为本条目挑一个尚未被其他预笔记占用的颜色。"""
        result = await db.execute(
            select(EntryAnnotation.id, EntryAnnotation.color).where(
                EntryAnnotation.entry_id == entry_id,
                EntryAnnotation.kind == "chat_anchor",
            )
        )
        used: set[str] = set()
        for rid, color in result.all():
            if exclude_id is not None and int(rid) == int(exclude_id):
                continue
            if color:
                used.add(str(color).lower())
        return pick_chat_anchor_color(used)

    async def list_annotations(self, db: AsyncSession, entry_id: int) -> AnnotationListOut:
        entry = await db.get(Entry, entry_id)
        if not entry:
            raise HTTPException(status_code=404, detail="条目不存在")
        result = await db.execute(
            select(EntryAnnotation)
            .where(EntryAnnotation.entry_id == entry_id)
            .order_by(EntryAnnotation.start_offset, EntryAnnotation.id)
        )
        rows = list(result.scalars().all())
        changed = await self._dedupe_chat_anchor_colors(db, rows)
        changed = await self._collapse_nested_chat_anchors(db, rows) or changed
        if changed:
            await db.commit()
            result = await db.execute(
                select(EntryAnnotation)
                .where(EntryAnnotation.entry_id == entry_id)
                .order_by(EntryAnnotation.start_offset, EntryAnnotation.id)
            )
            rows = list(result.scalars().all())
        return AnnotationListOut(items=[self._ann_out(r) for r in rows])

    async def _collapse_nested_chat_anchors(
        self, db: AsyncSession, rows: list[EntryAnnotation]
    ) -> bool:
        """删除被更长预笔记覆盖（或紧邻同段）的短预笔记。"""
        anchors = [
            r
            for r in rows
            if (getattr(r, "kind", None) or "") == "chat_anchor"
            or (not getattr(r, "kind", None) and (r.note or "").startswith("对话引用"))
        ]
        if len(anchors) < 2:
            return False
        # 长的优先保留
        ordered = sorted(
            anchors,
            key=lambda r: (-(int(r.end_offset) - int(r.start_offset)), int(r.id)),
        )
        keep: list[EntryAnnotation] = []
        delete_ids: list[int] = []
        # keep_id -> labels absorbed from deleted shorts
        absorb: dict[int, list[str]] = {}
        for row in ordered:
            s, e = int(row.start_offset), int(row.end_offset)
            host = next(
                (
                    k
                    for k in keep
                    if ranges_same_passage(s, e, int(k.start_offset), int(k.end_offset))
                ),
                None,
            )
            if host is not None:
                delete_ids.append(int(row.id))
                absorb.setdefault(int(host.id), []).append(label_from_anchor_note(row.note))
            else:
                keep.append(row)
        if not delete_ids:
            return False
        for host in keep:
            extras = absorb.get(int(host.id)) or []
            if not extras:
                continue
            merged = merge_point_labels(label_from_anchor_note(host.note), *extras)
            if merged:
                host.note = anchor_note_from_label(merged)
        for did in delete_ids:
            victim = await db.get(EntryAnnotation, did)
            if victim is not None:
                await db.delete(victim)
        await db.flush()
        return True

    async def _dedupe_chat_anchor_colors(
        self, db: AsyncSession, rows: list[EntryAnnotation]
    ) -> bool:
        """同条目预笔记若颜色撞车，自动换成调色板中未占用的颜色。正式笔记不动。"""
        anchors = [r for r in rows if (getattr(r, "kind", None) or "") == "chat_anchor"
                   or (not getattr(r, "kind", None) and (r.note or "").startswith("对话引用"))]
        if len(anchors) < 2:
            return False
        used: set[str] = set()
        changed = False
        for row in anchors:
            c = (row.color or "").strip().lower() or "#60a5fa"
            if c in used:
                new_c = pick_chat_anchor_color(used)
                row.color = new_c
                used.add(new_c.lower())
                changed = True
            else:
                used.add(c)
                if not (row.color or "").strip():
                    row.color = c
                    changed = True
        if changed:
            await db.flush()
        return changed

    async def ensure_chat_anchor(
        self,
        db: AsyncSession,
        entry_id: int,
        *,
        start_offset: int,
        end_offset: int,
        quote: str,
        label: str = "",
    ) -> EntryAnnotation | None:
        """为对话引用创建或复用预笔记高亮（kind=chat_anchor，不混入正式笔记）。"""
        entry = await db.get(Entry, entry_id)
        if not entry:
            return None

        start = max(0, int(start_offset))
        end = max(start + 1, int(end_offset))
        if end - start > 2000:
            end = start + 2000
        q = (quote or "").strip()
        if not q:
            return None
        if len(q) > 2000:
            q = q[:2000]

        label_clean = re.sub(r"\s+", " ", (label or "").strip())[:40]
        note = anchor_note_from_label(label_clean)

        # 复用同 entry 下同段落锚点（重叠 / 短段被包含 / 相邻），避免一条知识点多条高亮。
        overlap = await db.execute(
            select(EntryAnnotation)
            .where(
                EntryAnnotation.entry_id == entry_id,
                EntryAnnotation.kind == "chat_anchor",
                EntryAnnotation.start_offset < end + 120,
                EntryAnnotation.end_offset > start - 120,
            )
            .order_by(EntryAnnotation.id.desc())
        )
        rows = overlap.scalars().all()

        best: EntryAnnotation | None = None
        best_score = -1.0
        for cand in rows:
            cs, ce = int(cand.start_offset), int(cand.end_offset)
            if not ranges_same_passage(start, end, cs, ce):
                continue
            # 优先合并进更长的已有锚点
            score = float(ce - cs)
            if score > best_score:
                best_score = score
                best = cand

        if best is not None:
            row = best
            old_len = int(row.end_offset) - int(row.start_offset)
            new_len = end - start
            # 取更长的那一段作为最终高亮；短段并入长段时不缩短
            if new_len >= old_len:
                row.start_offset = start
                row.end_offset = end
                row.quote = q
            # 合并标题：思维触觉 + 身体直觉 → 思维触觉 · 身体直觉
            merged = merge_point_labels(label_from_anchor_note(row.note), label_clean)
            if merged:
                row.note = anchor_note_from_label(merged)
            if not (row.color or "").strip():
                row.color = await self._next_chat_anchor_color(db, entry_id, exclude_id=row.id)
            row.kind = "chat_anchor"
            await db.flush()
            return row

        existing = await db.execute(
            select(EntryAnnotation)
            .where(
                EntryAnnotation.entry_id == entry_id,
                EntryAnnotation.start_offset == start,
                EntryAnnotation.kind == "chat_anchor",
            )
            .order_by(EntryAnnotation.id.desc())
            .limit(1)
        )
        row = existing.scalar_one_or_none()
        if row is None:
            # 兼容旧数据：曾用 note 前缀标记
            legacy = await db.execute(
                select(EntryAnnotation)
                .where(
                    EntryAnnotation.entry_id == entry_id,
                    EntryAnnotation.start_offset == start,
                    EntryAnnotation.note.like("对话引用%"),
                )
                .order_by(EntryAnnotation.id.desc())
                .limit(1)
            )
            row = legacy.scalar_one_or_none()

        if row is not None:
            row.end_offset = end
            row.quote = q
            row.note = note
            if not (row.color or "").strip():
                row.color = await self._next_chat_anchor_color(db, entry_id, exclude_id=row.id)
            row.kind = "chat_anchor"
            await db.flush()
            return row

        color = await self._next_chat_anchor_color(db, entry_id)
        row = EntryAnnotation(
            entry_id=entry_id,
            start_offset=start,
            end_offset=end,
            quote=q,
            note=note,
            kind="chat_anchor",
            color=color,
        )
        db.add(row)
        await db.flush()
        return row

    @staticmethod
    def _normalize_rect_json(raw: str | None) -> str:
        import json

        text = (raw or "").strip()
        if not text:
            return ""
        try:
            data = json.loads(text)
            if not isinstance(data, dict):
                raise ValueError("rect_json 须为对象")
            x = float(data.get("x", 0))
            y = float(data.get("y", 0))
            w = float(data.get("w", 0))
            h = float(data.get("h", 0))
            # 归一化到页面 0~1，允许轻微越界后夹紧
            x = max(0.0, min(1.0, x))
            y = max(0.0, min(1.0, y))
            w = max(0.0, min(1.0 - x, w))
            h = max(0.0, min(1.0 - y, h))
            if w < 0.005 or h < 0.005:
                raise ValueError("标注区域过小")
            return json.dumps({"x": x, "y": y, "w": w, "h": h}, ensure_ascii=False)
        except HTTPException:
            raise
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail=f"区域坐标无效：{exc}") from exc

    async def create_annotation(
        self, db: AsyncSession, entry_id: int, payload: AnnotationCreate
    ) -> AnnotationOut:
        entry = await db.get(Entry, entry_id)
        if not entry:
            raise HTTPException(status_code=404, detail="条目不存在")

        page = int(payload.page) if payload.page is not None else None
        if page is not None and page < 1:
            raise HTTPException(status_code=400, detail="页码无效")

        if page is not None:
            # PDF 页内笔记：可不绑定正文偏移
            start, end = 0, 0
            quote = (payload.quote or "").strip() or f"第{page}页"
            rect_json = self._normalize_rect_json(payload.rect_json)
        else:
            start = int(payload.start_offset)
            end = int(payload.end_offset)
            if start < 0 or end <= start:
                raise HTTPException(status_code=400, detail="划选区间无效")
            if end - start > 2000:
                raise HTTPException(status_code=400, detail="单次划选不超过 2000 字")
            quote = (payload.quote or "").strip()
            if not quote:
                raise HTTPException(status_code=400, detail="缺少划选原文")
            rect_json = ""

        if len(quote) > 2000:
            quote = quote[:2000]

        kind = (payload.kind or "note").strip().lower()
        if kind not in {"note", "chat_anchor"}:
            kind = "note"

        try:
            color = normalize_ann_color(payload.color)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        row = EntryAnnotation(
            entry_id=entry_id,
            start_offset=start,
            end_offset=end,
            quote=quote,
            note=(payload.note or "").strip(),
            kind=kind,
            color=color,
            page=page,
            rect_json=rect_json,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return self._ann_out(row)

    async def promote_annotation(
        self,
        db: AsyncSession,
        ann_id: int,
        payload: AnnotationPromoteIn | None = None,
    ) -> AnnotationOut:
        """将对话预笔记确认为正式笔记。"""
        payload = payload or AnnotationPromoteIn()
        row = await db.get(EntryAnnotation, ann_id)
        if not row:
            raise HTTPException(status_code=404, detail="笔记不存在")
        kind = (getattr(row, "kind", None) or "note").strip().lower()
        is_anchor = kind == "chat_anchor" or (row.note or "").startswith("对话引用")
        if not is_anchor:
            raise HTTPException(status_code=400, detail="仅对话预笔记可确认加入正式笔记")

        note = (payload.note or "").strip()
        if not note:
            # 去掉「对话引用｜」前缀，保留标签作默认笔记名
            raw = (row.note or "").strip()
            if raw.startswith("对话引用｜"):
                note = raw[len("对话引用｜") :].strip()
            elif raw.startswith("对话引用"):
                note = ""
            else:
                note = raw
        row.note = note
        row.kind = "note"
        if payload.color is not None:
            try:
                row.color = normalize_ann_color(payload.color)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        elif (row.color or "").lower() == "#60a5fa":
            # 预笔记默认蓝 → 正式笔记默认黄，便于区分
            row.color = "#facc15"
        await db.commit()
        await db.refresh(row)
        return self._ann_out(row)

    async def update_annotation(
        self, db: AsyncSession, ann_id: int, payload: AnnotationUpdate
    ) -> AnnotationOut:
        row = await db.get(EntryAnnotation, ann_id)
        if not row:
            raise HTTPException(status_code=404, detail="笔记不存在")
        if payload.note is not None:
            row.note = payload.note.strip()
        if payload.color is not None:
            try:
                row.color = normalize_ann_color(payload.color)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        if payload.page is not None:
            if int(payload.page) < 1:
                raise HTTPException(status_code=400, detail="页码无效")
            row.page = int(payload.page)
        if payload.rect_json is not None:
            row.rect_json = self._normalize_rect_json(payload.rect_json)

        page = getattr(row, "page", None)
        if payload.start_offset is not None or payload.end_offset is not None or payload.quote is not None:
            if page is not None:
                # 页内笔记：允许无正文偏移，仅更新 quote
                if payload.quote is not None:
                    quote = payload.quote.strip() or f"第{int(page)}页"
                    row.quote = quote[:2000]
            else:
                start = (
                    int(payload.start_offset)
                    if payload.start_offset is not None
                    else int(row.start_offset)
                )
                end = (
                    int(payload.end_offset)
                    if payload.end_offset is not None
                    else int(row.end_offset)
                )
                if start < 0 or end <= start:
                    raise HTTPException(status_code=400, detail="划选区间无效")
                if end - start > 2000:
                    end = start + 2000
                quote = (payload.quote if payload.quote is not None else row.quote or "").strip()
                if not quote:
                    raise HTTPException(status_code=400, detail="缺少划选原文")
                if len(quote) > 2000:
                    quote = quote[:2000]
                row.start_offset = start
                row.end_offset = end
                row.quote = quote
        await db.commit()
        await db.refresh(row)
        return self._ann_out(row)

    async def expand_annotation(
        self,
        db: AsyncSession,
        ann_id: int,
        payload: AnnotationExpandIn | None = None,
    ) -> AnnotationOut:
        """手动小步扩/缩高亮区间（一次一句或一行）。"""
        payload = payload or AnnotationExpandIn()
        row = await db.get(EntryAnnotation, ann_id)
        if not row:
            raise HTTPException(status_code=404, detail="笔记不存在")
        entry = await db.get(Entry, row.entry_id)
        if not entry:
            raise HTTPException(status_code=404, detail="条目不存在")
        source = await db.get(Source, entry.source_id) if entry.source_id else None
        full = read_entry_text(entry, source)
        if not full:
            raise HTTPException(status_code=400, detail="找不到原文，无法调整高亮")

        direction = (payload.direction or "after").strip().lower()
        sentences = max(1, int(payload.sentences or 1))
        cur_start = int(row.start_offset or 0)
        cur_end = int(row.end_offset or cur_start + 1)

        if direction in ("shrink_before", "shrink_after"):
            start, end = step_shrink(
                full,
                cur_start,
                cur_end,
                direction="before" if direction == "shrink_before" else "after",
                sentences=sentences,
            )
        elif direction in ("before", "after", "both"):
            start, end = step_expand(full, cur_start, cur_end, direction=direction, sentences=sentences)
        else:
            raise HTTPException(status_code=400, detail="direction 无效")

        if end <= start:
            raise HTTPException(status_code=400, detail="不能再收缩了")
        if end - start > 2000:
            # 以原起点为优先保留
            end = start + 2000
        quote = full[start:end]
        row.start_offset = start
        row.end_offset = end
        row.quote = quote
        await db.commit()
        await db.refresh(row)
        return self._ann_out(row)

    async def delete_annotation(self, db: AsyncSession, ann_id: int) -> None:
        row = await db.get(EntryAnnotation, ann_id)
        if not row:
            raise HTTPException(status_code=404, detail="笔记不存在")
        await db.delete(row)
        await db.commit()


knowledge_service = KnowledgeService()
