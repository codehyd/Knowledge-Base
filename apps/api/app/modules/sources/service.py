from __future__ import annotations

import re
from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.knowledge.models import Category, Entry, EntryCategory
from app.modules.knowledge.index import index_entry
from app.modules.settings_ai.service import settings_ai_service
from app.modules.sources.classify import (
    content_fingerprint,
    normalize_title_key,
    suggest_tags_and_summary,
)
from app.modules.sources.extractors import (
    extract_local_file,
    extract_video_subs_sync,
    extract_webpage,
    looks_like_video_url,
)
from app.modules.sources.models import Source
from app.modules.sources.preview_search import search_text_hits
from app.modules.sources.schemas import (
    IngestOut,
    PasteIn,
    PreviewSearchOut,
    SourceOut,
    SourcePreviewOut,
    TranscriptIn,
    UrlIn,
)

SUMMARY_CHARS = 800
PREVIEW_MAX_LIMIT = 50000
PREVIEW_DEFAULT_LIMIT = 12000
PREVIEWABLE_STATUS = {"ready", "committed", "need_transcript"}

ALLOWED_EBOOK = {".pdf", ".epub", ".txt"}
ALLOWED_NOTE = {".md", ".markdown", ".txt"}
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
# service.py → sources → modules → app → api → apps → 仓库根
_REPO_ROOT = Path(__file__).resolve().parents[5]


def _data_root() -> Path:
    settings = get_settings()
    root = Path(settings.data_dir)
    if not root.is_absolute():
        root = _REPO_ROOT / root
    root.mkdir(parents=True, exist_ok=True)
    (root / "uploads").mkdir(parents=True, exist_ok=True)
    return root


def _safe_name(name: str) -> str:
    name = Path(name).name
    name = re.sub(r"[^\w.\u4e00-\u9fff\-]+", "_", name, flags=re.UNICODE)
    return name[:180] or "file"


class SourcesService:
    def to_out(self, row: Source) -> SourceOut:
        return SourceOut.model_validate(row)

    async def list_sources(self, db: AsyncSession, limit: int = 50) -> tuple[list[Source], int]:
        total = int((await db.execute(select(func.count()).select_from(Source))).scalar_one())
        result = await db.execute(
            select(Source).order_by(desc(Source.created_at)).limit(min(limit, 100))
        )
        return list(result.scalars().all()), total

    async def get(self, db: AsyncSession, source_id: int) -> Source:
        row = await db.get(Source, source_id)
        if not row:
            raise HTTPException(status_code=404, detail="来源不存在")
        return row

    async def create_upload(
        self,
        db: AsyncSession,
        *,
        file: UploadFile,
        source_type: str,
    ) -> Source:
        if source_type not in {"ebook", "note"}:
            raise HTTPException(status_code=400, detail="type 仅支持 ebook / note")

        filename = _safe_name(file.filename or "upload.bin")
        suffix = Path(filename).suffix.lower()
        allowed = ALLOWED_EBOOK if source_type == "ebook" else ALLOWED_NOTE
        if suffix not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"不支持的扩展名 {suffix or '(无)'}，允许：{', '.join(sorted(allowed))}",
            )

        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="空文件")
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=400, detail="文件超过 200MB 限制")

        row = Source(
            type=source_type,
            title=Path(filename).stem,
            filename=filename,
            status="pending",
            stage="queued",
            progress=0,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)

        folder = _data_root() / "uploads" / str(row.id)
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / f"original{suffix}"
        dest.write_bytes(data)

        row.storage_path = str(dest.relative_to(_data_root())).replace("\\", "/")
        row.status = "pending"
        row.stage = "saved"
        row.progress = 5
        await db.commit()
        await db.refresh(row)
        return row

    async def create_paste(self, db: AsyncSession, payload: PasteIn) -> Source:
        content = payload.content.strip()
        if not content:
            raise HTTPException(status_code=400, detail="内容不能为空")
        title = (payload.title or "").strip() or content.splitlines()[0][:80] or "未命名笔记"

        row = Source(
            type="note",
            title=title,
            filename="paste.md",
            status="pending",
            stage="queued",
            progress=0,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)

        folder = _data_root() / "uploads" / str(row.id)
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / "original.md"
        dest.write_text(content, encoding="utf-8")

        row.storage_path = str(dest.relative_to(_data_root())).replace("\\", "/")
        row.stage = "saved"
        row.progress = 5
        await db.commit()
        await db.refresh(row)
        return row

    async def create_url(self, db: AsyncSession, payload: UrlIn) -> Source:
        url = payload.url.strip()
        if not (url.startswith("http://") or url.startswith("https://")):
            raise HTTPException(status_code=400, detail="请输入 http(s) 链接")

        is_video = looks_like_video_url(url)
        row = Source(
            type="video_url" if is_video else "url",
            title=urlparse_title(url),
            filename="",
            source_uri=url,
            status="pending",
            stage="queued",
            progress=0,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)

        folder = _data_root() / "uploads" / str(row.id)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "source.url").write_text(url, encoding="utf-8")
        row.storage_path = str((folder / "source.url").relative_to(_data_root())).replace("\\", "/")
        row.stage = "saved"
        row.progress = 5
        await db.commit()
        await db.refresh(row)
        return row

    async def attach_transcript(self, db: AsyncSession, source_id: int, payload: TranscriptIn) -> Source:
        row = await self.get(db, source_id)
        if row.type not in {"video_url", "url"}:
            raise HTTPException(status_code=400, detail="仅链接类来源可补贴文案")
        text = payload.content.strip()
        if not text:
            raise HTTPException(status_code=400, detail="文案不能为空")

        folder = _data_root() / "uploads" / str(row.id)
        folder.mkdir(parents=True, exist_ok=True)
        text_file = folder / "extracted.txt"
        text_file.write_text(text, encoding="utf-8")
        row.text_path = str(text_file.relative_to(_data_root())).replace("\\", "/")
        row.char_count = len(text)
        row.status = "ready"
        row.stage = "manual_transcript"
        row.progress = 100
        row.error_message = ""
        await db.commit()
        await db.refresh(row)
        return row

    async def clear_finished(self, db: AsyncSession) -> int:
        result = await db.execute(
            select(Source).where(Source.status.in_(["ready", "failed", "committed"]))
        )
        rows = list(result.scalars().all())
        for row in rows:
            await db.delete(row)
        await db.commit()
        return len(rows)

    async def _ensure_category(self, db: AsyncSession, name: str) -> Category:
        result = await db.execute(select(Category).where(Category.name == name))
        cat = result.scalar_one_or_none()
        if cat:
            return cat
        cat = Category(name=name)
        db.add(cat)
        await db.flush()
        return cat

    def _read_extracted_text(self, row: Source) -> str:
        if not row.text_path:
            raise HTTPException(status_code=400, detail="缺少抽取正文")
        path = _data_root() / row.text_path
        if not path.is_file():
            raise HTTPException(status_code=400, detail="正文文件不存在，请先重新抽取")
        return path.read_text(encoding="utf-8")

    async def get_preview(
        self,
        db: AsyncSession,
        source_id: int,
        *,
        offset: int = 0,
        limit: int = PREVIEW_DEFAULT_LIMIT,
    ) -> SourcePreviewOut:
        row = await self.get(db, source_id)
        if row.status not in PREVIEWABLE_STATUS:
            raise HTTPException(
                status_code=400,
                detail=f"当前状态「{row.status}」暂无正文可预览",
            )
        text = self._read_extracted_text(row)
        offset = max(0, offset)
        limit = min(max(1, limit), PREVIEW_MAX_LIMIT)
        chunk = text[offset : offset + limit]
        return SourcePreviewOut(
            source_id=row.id,
            title=(row.title or row.filename or f"来源 #{row.id}"),
            filename=row.filename or "",
            status=row.status,
            char_count=len(text),
            text=chunk,
            offset=offset,
            limit=limit,
            truncated=offset + len(chunk) < len(text),
        )

    async def search_preview(
        self,
        db: AsyncSession,
        source_id: int,
        *,
        query: str,
        offset: int = 0,
        limit: int = 100,
    ) -> PreviewSearchOut:
        row = await self.get(db, source_id)
        if row.status not in PREVIEWABLE_STATUS:
            raise HTTPException(
                status_code=400,
                detail=f"当前状态「{row.status}」暂无正文可搜索",
            )
        q = (query or "").strip()
        if not q:
            raise HTTPException(status_code=400, detail="请输入搜索词")
        if len(q) > 80:
            raise HTTPException(status_code=400, detail="搜索词过长")
        text = self._read_extracted_text(row)
        offset = max(0, offset)
        limit = min(max(1, limit), 500)
        hits, total = search_text_hits(text, q, offset=offset, limit=limit)
        return PreviewSearchOut(
            query=q, total=total, offset=offset, limit=limit, hits=hits
        )

    async def _assert_not_duplicate(
        self,
        db: AsyncSession,
        *,
        title: str,
        filename: str,
        content_hash: str,
        source_id: int,
    ) -> None:
        title_key = normalize_title_key(title)
        file_key = normalize_title_key(filename) if filename else ""

        if content_hash:
            hit = await db.execute(
                select(Entry).where(Entry.content_hash == content_hash).limit(1)
            )
            if hit.scalar_one_or_none():
                raise HTTPException(status_code=409, detail="相同正文已入库，请勿重复添加")

        if title_key:
            hit = await db.execute(
                select(Entry).where(Entry.title_key == title_key).limit(1)
            )
            if hit.scalar_one_or_none():
                raise HTTPException(status_code=409, detail="相同标题已入库，请勿重复添加")

        # 兼容旧数据：尚未写 title_key / content_hash 时，用规范化比较兜底
        legacy = await db.execute(select(Entry.id, Entry.title, Entry.source_id))
        for eid, etitle, esid in legacy.all():
            if esid == source_id:
                raise HTTPException(status_code=409, detail="该来源已有对应条目，请勿重复入库")
            if title_key and normalize_title_key(etitle or "") == title_key:
                raise HTTPException(status_code=409, detail="相同标题已入库，请勿重复添加")

        # 其它已入库来源：同文件名视为同一本书
        if file_key:
            sources = await db.execute(
                select(Source).where(
                    Source.status == "committed",
                    Source.id != source_id,
                )
            )
            for other in sources.scalars().all():
                if normalize_title_key(other.filename or "") == file_key:
                    raise HTTPException(
                        status_code=409, detail="相同文件名已入库，请勿重复添加"
                    )
                if title_key and normalize_title_key(other.title or "") == title_key:
                    raise HTTPException(
                        status_code=409, detail="相同标题已入库，请勿重复添加"
                    )

    async def _llm_creds(self, db: AsyncSession) -> dict[str, str] | None:
        row = await settings_ai_service._get_or_create(db)
        key = (row.api_key or "").strip()
        if not key:
            return None
        return {
            "api_key": key,
            "base_url": (row.base_url or "").rstrip("/"),
            "model": row.chat_model or "deepseek-chat",
        }

    async def ingest(self, db: AsyncSession, source_id: int) -> IngestOut:
        row = await self.get(db, source_id)
        if row.status == "committed":
            raise HTTPException(status_code=409, detail="该来源已入库，请勿重复操作")
        if row.status != "ready":
            raise HTTPException(
                status_code=400,
                detail=f"仅 ready 状态可入库，当前为 {row.status}",
            )

        existing = await db.execute(select(Entry).where(Entry.source_id == source_id).limit(1))
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="该来源已有对应条目，请勿重复入库")

        text = self._read_extracted_text(row).strip()
        if not text:
            raise HTTPException(status_code=400, detail="正文为空，无法入库")

        title = (row.title or row.filename or f"来源 #{row.id}").strip()[:500]
        digest = content_fingerprint(text)
        await self._assert_not_duplicate(
            db,
            title=title,
            filename=row.filename or "",
            content_hash=digest,
            source_id=row.id,
        )

        llm = await self._llm_creds(db)
        tags, summary = await suggest_tags_and_summary(title=title, text=text, llm=llm)
        if not tags:
            tags = ["未命名主题"]
        summary = (summary or text[:SUMMARY_CHARS]).strip()
        if len(summary) > SUMMARY_CHARS:
            summary = summary[:SUMMARY_CHARS].rstrip() + "…"

        entry = Entry(
            title=title,
            summary=summary,
            source_id=row.id,
            title_key=normalize_title_key(title),
            content_hash=digest,
        )
        db.add(entry)
        await db.flush()
        for tag in tags:
            category = await self._ensure_category(db, tag)
            db.add(EntryCategory(entry_id=entry.id, category_id=category.id))

        row.status = "committed"
        row.stage = "committed"
        row.progress = 100
        row.error_message = ""
        await db.commit()
        await db.refresh(entry)

        # 入库后建立对话检索切片（embedding 失败则仅存文本，聊天时走关键词）
        try:
            await index_entry(db, entry.id, with_embed=True)
        except Exception:
            # 索引失败不回滚入库；可稍后 reindex
            pass

        return IngestOut(
            source_id=row.id,
            entry_id=entry.id,
            title=entry.title,
            category=tags[0],
            categories=tags,
        )

    async def ingest_ready(self, db: AsyncSession) -> tuple[list[IngestOut], int, list[dict]]:
        result = await db.execute(select(Source).where(Source.status == "ready"))
        rows = list(result.scalars().all())
        ingested: list[IngestOut] = []
        failed: list[dict] = []
        skipped = 0
        for row in rows:
            try:
                out = await self.ingest(db, row.id)
                ingested.append(out)
            except HTTPException as exc:
                if exc.status_code == 409:
                    skipped += 1
                    failed.append({"source_id": row.id, "detail": str(exc.detail)})
                else:
                    failed.append({"source_id": row.id, "detail": str(exc.detail)})
            except Exception as exc:  # noqa: BLE001
                failed.append({"source_id": row.id, "detail": str(exc)[:300]})
        return ingested, skipped, failed

    async def process_extract(self, db: AsyncSession, source_id: int) -> Source:
        row = await self.get(db, source_id)
        try:
            row.status = "processing"
            row.stage = "extract_text"
            row.progress = 20
            row.error_message = ""
            await db.commit()

            text = ""
            if row.type in {"ebook", "note"}:
                if not row.storage_path:
                    raise ValueError("缺少原件路径")
                path = _data_root() / row.storage_path
                # PDF 可能回退 OCR，阶段文案区分便于队列展示
                if path.suffix.lower() == ".pdf":
                    row.stage = "extract_or_ocr"
                    row.progress = 25
                    await db.commit()
                text = extract_local_file(path)
            elif row.type == "url":
                row.status = "extracting"
                row.stage = "fetch_page"
                row.progress = 30
                await db.commit()
                text = await extract_webpage(row.source_uri)
            elif row.type == "video_url":
                row.status = "extracting"
                row.stage = "extract_caption"
                row.progress = 30
                await db.commit()
                work = _data_root() / "uploads" / str(row.id) / "subs"
                try:
                    text = extract_video_subs_sync(row.source_uri, work)
                except ValueError as exc:
                    row.status = "need_transcript"
                    row.stage = "need_transcript"
                    row.progress = 40
                    row.error_message = str(exc)
                    await db.commit()
                    await db.refresh(row)
                    return row
            else:
                raise ValueError(f"未知类型 {row.type}")

            folder = _data_root() / "uploads" / str(row.id)
            folder.mkdir(parents=True, exist_ok=True)
            text_file = folder / "extracted.txt"
            text_file.write_text(text, encoding="utf-8")

            row.text_path = str(text_file.relative_to(_data_root())).replace("\\", "/")
            row.char_count = len(text)
            row.status = "ready"
            row.stage = "extracted"
            row.progress = 100
            row.error_message = ""
            if not row.title:
                row.title = text.splitlines()[0][:80] if text else f"来源 #{row.id}"
            await db.commit()
            await db.refresh(row)
            return row
        except Exception as exc:  # noqa: BLE001
            row.status = "failed"
            row.stage = "failed"
            row.error_message = str(exc)[:500]
            row.progress = 100
            await db.commit()
            await db.refresh(row)
            return row


def urlparse_title(url: str) -> str:
    from urllib.parse import urlparse

    host = urlparse(url).hostname or "链接"
    return f"{host} 材料"


sources_service = SourcesService()
