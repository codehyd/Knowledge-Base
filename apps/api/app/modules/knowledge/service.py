from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.knowledge.models import Category, Entry, EntryAnnotation, EntryCategory
from app.modules.knowledge.schemas import (
    AnnotationCreate,
    AnnotationListOut,
    AnnotationOut,
    AnnotationUpdate,
    CategoryListOut,
    CategoryOut,
    EntryDetailOut,
    EntryListItem,
    EntryListOut,
    EntryPreviewOut,
    normalize_ann_color,
)
from app.modules.sources.models import Source
from app.modules.sources.preview_search import search_text_hits
from app.modules.sources.schemas import PreviewSearchOut
from app.modules.sources.service import PREVIEW_DEFAULT_LIMIT, sources_service

# service.py → knowledge → modules → app → api → apps → 仓库根
_REPO_ROOT = Path(__file__).resolve().parents[5]
PREVIEW_CHARS = 4000


def _data_root() -> Path:
    settings = get_settings()
    root = Path(settings.data_dir)
    if not root.is_absolute():
        root = _REPO_ROOT / root
    return root


class KnowledgeService:
    async def _categories_for_entries(
        self, db: AsyncSession, entry_ids: list[int]
    ) -> dict[int, list[str]]:
        if not entry_ids:
            return {}
        result = await db.execute(
            select(EntryCategory.entry_id, Category.name)
            .join(Category, Category.id == EntryCategory.category_id)
            .where(EntryCategory.entry_id.in_(entry_ids))
            .order_by(Category.name)
        )
        mapping: dict[int, list[str]] = {eid: [] for eid in entry_ids}
        for entry_id, name in result.all():
            mapping.setdefault(entry_id, []).append(name)
        return mapping

    async def list_categories(self, db: AsyncSession) -> CategoryListOut:
        total_entries = int(
            (await db.execute(select(func.count()).select_from(Entry))).scalar_one()
        )
        # 顺手清掉无条目的空分类（如旧版「电子书」残留）
        await self._prune_empty_categories(db)

        counts = (
            await db.execute(
                select(Category.id, Category.name, func.count(EntryCategory.entry_id))
                .join(EntryCategory, EntryCategory.category_id == Category.id)
                .group_by(Category.id, Category.name)
                .order_by(Category.name)
            )
        ).all()
        items = [
            CategoryOut(id=row[0], name=row[1], count=int(row[2] or 0)) for row in counts
        ]
        return CategoryListOut(items=items, total_entries=total_entries)

    async def _prune_empty_categories(self, db: AsyncSession) -> None:
        used = select(EntryCategory.category_id).distinct()
        result = await db.execute(select(Category).where(Category.id.not_in(used)))
        orphans = list(result.scalars().all())
        if not orphans:
            return
        for cat in orphans:
            await db.delete(cat)
        await db.commit()

    async def list_entries(
        self,
        db: AsyncSession,
        *,
        q: str = "",
        category: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> EntryListOut:
        page = max(1, page)
        page_size = min(max(1, page_size), 100)

        stmt = select(Entry)
        count_stmt = select(func.count()).select_from(Entry)

        if category.strip():
            cat_filter = (
                select(EntryCategory.entry_id)
                .join(Category, Category.id == EntryCategory.category_id)
                .where(Category.name == category.strip())
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
        result = await db.execute(
            stmt.order_by(desc(Entry.created_at))
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        rows = list(result.scalars().all())
        cats = await self._categories_for_entries(db, [r.id for r in rows])
        items = [
            EntryListItem(
                id=r.id,
                title=r.title,
                summary=r.summary,
                source_id=r.source_id,
                categories=cats.get(r.id, []),
                created_at=r.created_at,
            )
            for r in rows
        ]
        return EntryListOut(items=items, total=total, page=page, page_size=page_size)

    async def get_entry(self, db: AsyncSession, entry_id: int) -> EntryDetailOut:
        row = await db.get(Entry, entry_id)
        if not row:
            raise HTTPException(status_code=404, detail="条目不存在")

        cats = await self._categories_for_entries(db, [row.id])
        preview = ""
        preview_truncated = False
        char_count = 0
        source_filename = ""
        source_type = ""
        if row.source_id:
            source = await db.get(Source, row.source_id)
            if source:
                source_filename = source.filename or ""
                source_type = source.type or ""
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
            categories=cats.get(row.id, []),
            created_at=row.created_at,
            preview=preview or row.summary,
            preview_truncated=preview_truncated,
            char_count=char_count or len(row.summary or ""),
            source_filename=source_filename,
            source_type=source_type,
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
        if len(q) > 80:
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

        source_id = row.source_id
        links = await db.execute(
            select(EntryCategory).where(EntryCategory.entry_id == entry_id)
        )
        for link in links.scalars().all():
            await db.delete(link)
        await db.delete(row)

        # 入库错了时：删条目后将来源恢复为 ready，便于重新入库
        if source_id:
            source = await db.get(Source, source_id)
            if source and source.status == "committed":
                source.status = "ready"
                source.stage = "extracted"
                source.progress = 100
                source.error_message = ""

        await db.commit()
        await self._prune_empty_categories(db)

    def _ann_out(self, row: EntryAnnotation) -> AnnotationOut:
        return AnnotationOut.model_validate(row)

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
        return AnnotationListOut(items=[self._ann_out(r) for r in rows])

    async def create_annotation(
        self, db: AsyncSession, entry_id: int, payload: AnnotationCreate
    ) -> AnnotationOut:
        entry = await db.get(Entry, entry_id)
        if not entry:
            raise HTTPException(status_code=404, detail="条目不存在")

        start = int(payload.start_offset)
        end = int(payload.end_offset)
        if start < 0 or end <= start:
            raise HTTPException(status_code=400, detail="划选区间无效")
        if end - start > 2000:
            raise HTTPException(status_code=400, detail="单次划选不超过 2000 字")

        quote = (payload.quote or "").strip()
        if not quote:
            raise HTTPException(status_code=400, detail="缺少划选原文")
        if len(quote) > 2000:
            quote = quote[:2000]

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
            color=color,
        )
        db.add(row)
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
