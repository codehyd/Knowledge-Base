from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.knowledge.models import Category, Chunk, Entry, EntryCategory
from app.modules.knowledge.index import index_entry
from app.modules.library.service import library_service, remove_source_from_library
from app.modules.settings_ai.service import settings_ai_service
from app.modules.sources.classify import (
    content_fingerprint,
    normalize_title_key,
    suggest_tags_and_summary,
)
from app.modules.sources.extractors import (
    _resolve_cookie_file,
    extract_local_file,
    extract_media_file_transcript_sync,
    extract_video_audio_transcript_sync,
    extract_video_subs_sync,
    extract_webpage,
    fetch_video_title_sync,
    looks_like_video_url,
    normalize_media_url,
    parse_share_input,
    resolve_media_url_sync,
)
from app.modules.sources.cues import (
    find_media_file,
    persist_media_copy,
    read_cues_file,
    write_cues_file,
)
from app.modules.sources.asr import download_audio_sync
from app.modules.sources.models import Source
from app.modules.sources.preview_search import search_text_hits
from app.modules.sources.schemas import (
    IngestOut,
    PasteIn,
    PreviewSearchOut,
    SourceCuesOut,
    SourceOut,
    SourcePreviewOut,
    TimedCueOut,
    TranscriptIn,
    UrlIn,
)

SUMMARY_CHARS = 800
PREVIEW_MAX_LIMIT = 50000
PREVIEW_DEFAULT_LIMIT = 12000
PREVIEWABLE_STATUS = {"ready", "committed", "need_transcript"}

ALLOWED_EBOOK = {".pdf", ".epub", ".txt"}
ALLOWED_NOTE = {".md", ".markdown", ".txt"}
ALLOWED_VIDEO = {
    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
    ".m4v",
    ".m4a",
    ".mp3",
    ".wav",
    ".aac",
    ".ogg",
    ".opus",
}
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
# 确认书籍：公版书库导入，或本地 EPUB/PDF（用户以 ebook 投递）
# 可能为书：本地 TXT 以 ebook 投递 —— 可标识，但不进书架
CONFIRMED_EBOOK_SUFFIX = {".epub", ".pdf"}
# service.py → sources → modules → app → api → apps → 仓库根
_REPO_ROOT = Path(__file__).resolve().parents[5]


def resolve_book_meta(
    *,
    source_type: str,
    filename: str,
    provenance: str = "",
) -> tuple[str, str]:
    """返回 (provenance, book_kind)。book_kind=confirmed 才可上书架。"""
    if source_type != "ebook":
        return "", ""
    prov = (provenance or "upload").strip() or "upload"
    if prov == "open_book":
        return "open_book", "confirmed"
    suffix = Path(filename or "").suffix.lower()
    if suffix in CONFIRMED_EBOOK_SUFFIX:
        return "upload", "confirmed"
    if suffix == ".txt":
        return "upload", "possible"
    return "upload", "possible"


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
        if source_type not in {"ebook", "note", "video"}:
            raise HTTPException(status_code=400, detail="type 仅支持 ebook / note / video")

        filename = _safe_name(file.filename or "upload.bin")
        suffix = Path(filename).suffix.lower()
        if source_type == "ebook":
            allowed = ALLOWED_EBOOK
            row_type = "ebook"
        elif source_type == "note":
            allowed = ALLOWED_NOTE
            row_type = "note"
        else:
            allowed = ALLOWED_VIDEO
            row_type = "video_file"
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

        provenance, book_kind = ("", "")
        if row_type == "ebook":
            provenance, book_kind = resolve_book_meta(
                source_type="ebook", filename=filename, provenance="upload"
            )

        row = Source(
            type=row_type,
            title=Path(filename).stem,
            filename=filename,
            provenance=provenance,
            book_kind=book_kind,
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

    async def create_from_bytes(
        self,
        db: AsyncSession,
        *,
        data: bytes,
        filename: str,
        title: str = "",
        source_type: str = "ebook",
        provenance: str = "upload",
    ) -> Source:
        """由公版书下载等内部路径投递文件（不经 UploadFile）。"""
        if source_type not in {"ebook", "note"}:
            raise HTTPException(status_code=400, detail="type 仅支持 ebook / note")
        if not data:
            raise HTTPException(status_code=400, detail="空文件")
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=400, detail="文件超过 200MB 限制")

        safe = _safe_name(filename or "book.bin")
        suffix = Path(safe).suffix.lower()
        allowed = ALLOWED_EBOOK if source_type == "ebook" else ALLOWED_NOTE
        if suffix not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"不支持的扩展名 {suffix or '(无)'}，允许：{', '.join(sorted(allowed))}",
            )

        resolved_prov, book_kind = resolve_book_meta(
            source_type=source_type, filename=safe, provenance=provenance
        )
        row = Source(
            type=source_type,
            title=(title or Path(safe).stem).strip() or Path(safe).stem,
            filename=safe,
            provenance=resolved_prov,
            book_kind=book_kind,
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
        try:
            url, share_title = parse_share_input(payload.url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        is_video = looks_like_video_url(url)
        # 短链先跟跳，避免 Unsupported URL / 标题变成 v.douyin.com材料
        if is_video:
            url = await asyncio.to_thread(resolve_media_url_sync, url)
            meta_title = await asyncio.to_thread(fetch_video_title_sync, url)
            # 平台元数据优先；分享口令仅作回退，并去掉 XM 等前缀噪声
            from app.modules.sources.extractors import _strip_share_title_noise

            cleaned_share = _strip_share_title_noise(share_title or "")
            title = (meta_title or cleaned_share or "").strip()
            if not title:
                from urllib.parse import urlparse as _urlparse

                host = (_urlparse(url).hostname or "").lower()
                title = "抖音视频" if "douyin" in host else "视频"
        else:
            title = share_title or urlparse_title(url)
        row = Source(
            type="video_url" if is_video else "url",
            title=title[:500],
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
        # 保留原始粘贴，便于排查分享口令
        raw = payload.url.strip()
        if raw != url:
            (folder / "share_raw.txt").write_text(raw, encoding="utf-8")
        row.storage_path = str((folder / "source.url").relative_to(_data_root())).replace("\\", "/")
        row.stage = "saved"
        row.progress = 5
        await db.commit()
        await db.refresh(row)
        return row

    async def attach_transcript(self, db: AsyncSession, source_id: int, payload: TranscriptIn) -> Source:
        row = await self.get(db, source_id)
        if row.type not in {"video_url", "video_file", "url"}:
            raise HTTPException(status_code=400, detail="仅视频/链接类来源可补贴文案")
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
        try:
            await library_service.sync_source(db, row.id)
        except Exception:
            pass
        return row

    async def clear_finished(self, db: AsyncSession) -> int:
        result = await db.execute(
            select(Source).where(Source.status.in_(["ready", "failed", "committed"]))
        )
        rows = list(result.scalars().all())
        ids = [row.id for row in rows]
        for row in rows:
            await db.delete(row)
        await db.commit()
        for sid in ids:
            folder = _data_root() / "uploads" / str(sid)
            if folder.exists():
                shutil.rmtree(folder, ignore_errors=True)
            remove_source_from_library(sid)
        return len(ids)

    async def delete_source(self, db: AsyncSession, source_id: int) -> None:
        row = await self.get(db, source_id)
        sid = row.id
        await db.delete(row)
        await db.commit()
        folder = _data_root() / "uploads" / str(sid)
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)
        remove_source_from_library(sid)

    async def _remove_entry_tree(self, db: AsyncSession, entry: Entry) -> None:
        """删除条目及其分类/切片，不改动来源状态（用于清理残留条目）。"""
        links = await db.execute(
            select(EntryCategory).where(EntryCategory.entry_id == entry.id)
        )
        for link in links.scalars().all():
            await db.delete(link)
        chunks = await db.execute(select(Chunk).where(Chunk.entry_id == entry.id))
        for chunk in chunks.scalars().all():
            await db.delete(chunk)
        await db.delete(entry)
        await db.flush()

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

    def _source_folder(self, source_id: int) -> Path:
        return _data_root() / "uploads" / str(source_id)

    def follow_along_ready(self, source_id: int) -> bool:
        """有本地音轨即可跟读播放（时间轴可选，用于高亮）。"""
        return find_media_file(self._source_folder(source_id)) is not None

    async def get_cues(self, db: AsyncSession, source_id: int) -> SourceCuesOut:
        row = await self.get(db, source_id)
        if row.type not in {"video_url", "video_file"}:
            raise HTTPException(status_code=400, detail="仅视频来源支持跟读")
        if row.status not in PREVIEWABLE_STATUS:
            raise HTTPException(
                status_code=400,
                detail=f"当前状态「{row.status}」尚无跟读数据",
            )
        folder = self._source_folder(row.id)
        cues = read_cues_file(folder / "cues.json")
        media = find_media_file(folder)
        return SourceCuesOut(
            source_id=row.id,
            title=(row.title or f"来源 #{row.id}"),
            has_media=media is not None,
            media_url=f"/api/sources/{row.id}/media" if media else "",
            cues=[TimedCueOut(start=c.start, end=c.end, text=c.text) for c in cues],
        )

    async def resolve_media_path(self, db: AsyncSession, source_id: int) -> Path:
        row = await self.get(db, source_id)
        if row.type not in {"video_url", "video_file"}:
            raise HTTPException(status_code=400, detail="仅视频来源有音轨")
        media = find_media_file(self._source_folder(row.id))
        if not media:
            raise HTTPException(
                status_code=404,
                detail="尚无音轨。请对该视频重新「重试」提取（会下载音轨供跟读）。",
            )
        return media

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
                src = await db.get(Source, source_id)
                if src and src.status == "committed":
                    raise HTTPException(status_code=409, detail="该来源已有对应条目，请勿重复入库")
                stale = await db.get(Entry, eid)
                if stale:
                    await self._remove_entry_tree(db, stale)
                break
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
        stale_entry = existing.scalar_one_or_none()
        if stale_entry:
            if row.status == "committed":
                raise HTTPException(status_code=409, detail="该来源已入库，请勿重复操作")
            # 喂养队列删来源后条目可能残留，或来源 id 被复用时会出现「条目在、来源 ready」
            await self._remove_entry_tree(db, stale_entry)

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

        try:
            await library_service.sync_source(db, row.id)
        except Exception:
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
            elif row.type == "video_file":
                # 用户上传的本地视频/音频：ffmpeg 抽轨 → ASR（无需下载授权）
                if not row.storage_path:
                    raise ValueError("缺少原件路径")
                media_src = _data_root() / row.storage_path
                if not media_src.is_file():
                    raise ValueError("原件不存在")
                asr_cfg = await settings_ai_service.asr_config(db)
                if (asr_cfg.get("asr_mode") or "auto") == "off":
                    row.status = "need_transcript"
                    row.stage = "need_transcript"
                    row.progress = 40
                    row.error_message = (
                        "语音转写已关闭。请在设置开启「视频语音转写」，或「补贴文案」。"
                    )
                    await db.commit()
                    await db.refresh(row)
                    return row
                folder = _data_root() / "uploads" / str(row.id)
                audio_work = folder / "audio"
                row.status = "extracting"
                row.stage = "asr"
                row.progress = 55
                row.error_message = ""
                await db.commit()
                try:
                    text, cues, audio_path = await asyncio.to_thread(
                        extract_media_file_transcript_sync,
                        media_src,
                        audio_work,
                        asr_cfg,
                    )
                except ValueError as asr_exc:
                    row.status = "need_transcript"
                    row.stage = "need_transcript"
                    row.progress = 40
                    row.error_message = f"语音转写失败：{asr_exc}"[:500]
                    await db.commit()
                    await db.refresh(row)
                    return row
            elif row.type == "video_url":
                row.status = "extracting"
                row.stage = "extract_caption"
                row.progress = 30
                await db.commit()
                folder = _data_root() / "uploads" / str(row.id)
                work = folder / "subs"
                audio_work = folder / "audio"
                cues: list = []
                audio_path = None
                # 旧条目可能存了带 share_sign 的脏链接 / 短链，提取前解析
                video_url = await asyncio.to_thread(
                    resolve_media_url_sync, row.source_uri or ""
                )
                if not video_url:
                    video_url = normalize_media_url(row.source_uri or "")
                if video_url and video_url != (row.source_uri or ""):
                    row.source_uri = video_url
                    try:
                        (folder / "source.url").write_text(video_url, encoding="utf-8")
                    except OSError:
                        pass
                    await db.commit()
                asr_cfg = await settings_ai_service.asr_config(db)
                allow_local_audio = asr_cfg.get("allow_local_audio") == "1"
                try:
                    text, cues = await asyncio.to_thread(
                        extract_video_subs_sync, video_url, work
                    )
                    # 仅在用户授权后下载音轨，供跟读播放（失败不阻断字幕路径）
                    if allow_local_audio:
                        try:
                            audio_path = await asyncio.to_thread(
                                download_audio_sync,
                                video_url,
                                audio_work,
                                _resolve_cookie_file(),
                            )
                        except Exception:  # noqa: BLE001
                            audio_path = None
                except ValueError as sub_exc:
                    # 无字幕 → 需音轨转写；未授权则不下载
                    if not allow_local_audio:
                        row.status = "need_transcript"
                        row.stage = "need_transcript"
                        row.progress = 40
                        row.error_message = (
                            f"{sub_exc} 未授权下载音轨到本机，无法自动语音转写。"
                            "请到「设置 → AI」开启「允许下载音轨到本机」，或「补贴文案」。"
                        )[:500]
                        await db.commit()
                        await db.refresh(row)
                        return row
                    if (asr_cfg.get("asr_mode") or "auto") == "off":
                        row.status = "need_transcript"
                        row.stage = "need_transcript"
                        row.progress = 40
                        row.error_message = (
                            f"{sub_exc} 语音转写已关闭，请在设置开启或「补贴文案」。"
                        )[:500]
                        await db.commit()
                        await db.refresh(row)
                        return row
                    row.stage = "asr"
                    row.progress = 55
                    row.error_message = ""
                    await db.commit()
                    try:
                        text, cues, audio_path = await asyncio.to_thread(
                            extract_video_audio_transcript_sync,
                            video_url,
                            audio_work,
                            asr_cfg,
                        )
                    except ValueError as asr_exc:
                        row.status = "need_transcript"
                        row.stage = "need_transcript"
                        row.progress = 40
                        row.error_message = (
                            f"{sub_exc} 语音转写失败：{asr_exc}"
                        )[:500]
                        await db.commit()
                        await db.refresh(row)
                        return row
            else:
                raise ValueError(f"未知类型 {row.type}")

            folder = _data_root() / "uploads" / str(row.id)
            folder.mkdir(parents=True, exist_ok=True)
            text_file = folder / "extracted.txt"
            text_file.write_text(text, encoding="utf-8")

            # 视频跟读：链接需授权落盘；本地上传始终保留音轨
            if row.type in {"video_url", "video_file"}:
                asr_cfg_final = await settings_ai_service.asr_config(db)
                allow_keep = (
                    row.type == "video_file"
                    or asr_cfg_final.get("allow_local_audio") == "1"
                )
                if allow_keep and cues:
                    write_cues_file(folder / "cues.json", cues)
                if allow_keep and audio_path is not None:
                    persist_media_copy(Path(audio_path), folder)
                elif not allow_keep and audio_path is not None:
                    audio_path = None

            row.text_path = str(text_file.relative_to(_data_root())).replace("\\", "/")
            row.char_count = len(text)
            row.status = "ready"
            row.stage = "extracted"
            row.progress = 100
            row.error_message = ""
            # 视频：提取时再校准一次平台标题（创建时若 Cookie 未就绪可能失败）
            if row.type == "video_url":
                meta_title = await asyncio.to_thread(
                    fetch_video_title_sync, row.source_uri
                )
                if meta_title:
                    row.title = meta_title
            if not (row.title or "").strip():
                row.title = text.splitlines()[0][:80] if text else f"来源 #{row.id}"
            await db.commit()
            await db.refresh(row)
            try:
                await library_service.sync_source(db, row.id)
            except Exception:
                pass
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
