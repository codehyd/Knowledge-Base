from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy import case, desc, func, select
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
    _is_douyin_url,
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
    probe_playlist_sync,
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
    SourceContentIn,
    SourceContentOut,
    SourceCuesOut,
    SourceOut,
    SourcePreviewOut,
    TimedCueOut,
    TranscriptIn,
    UrlBatchIn,
    UrlIn,
    UrlProbeOut,
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

    async def list_sources(self, db: AsyncSession, limit: int = 200) -> tuple[list[Source], int]:
        # 笔记库手写笔记不进喂养队列：它们由「笔记」页管理，清队列不应波及
        vault_note = (Source.vault_path.is_not(None)) & (Source.vault_path != "")
        total = int(
            (
                await db.execute(
                    select(func.count()).select_from(Source).where(~vault_note)
                )
            ).scalar_one()
        )
        # 进行中优先，再等待 → 待入库 → 失败/待补贴；同档按更新时间新的在前
        status_rank = case(
            (Source.status.in_(["extracting", "processing"]), 0),
            (Source.status == "pending", 1),
            (Source.status == "ready", 2),
            (Source.status.in_(["need_transcript", "failed"]), 3),
            else_=4,
        )
        result = await db.execute(
            select(Source)
            .where(~vault_note)
            .order_by(
                status_rank.asc(),
                desc(Source.updated_at),
                desc(Source.created_at),
            )
            .limit(min(limit, 500))
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

    async def probe_url(self, payload: UrlIn) -> UrlProbeOut:
        """探测链接是否为合集/分P（不落库）。仅视频链接有意义，网页直接返回非合集。"""
        try:
            url, _share_title = parse_share_input(payload.url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not looks_like_video_url(url):
            return UrlProbeOut()
        info = await asyncio.to_thread(probe_playlist_sync, url)
        raw_entries = list(info.get("entries") or [])
        return UrlProbeOut(
            is_playlist=bool(info.get("is_playlist")),
            collection_title=(info.get("collection_title") or "")[:500],
            total=int(info.get("total") or 0),
            entries=[
                {
                    "episode_no": int(e.get("episode_no") or 0),
                    "title": str(e.get("title") or ""),
                }
                for e in raw_entries
                if int(e.get("episode_no") or 0) > 0
            ],
        )

    async def create_url_batch(
        self, db: AsyncSession, payload: UrlBatchIn
    ) -> tuple[list[Source], int, str, int]:
        """合集/分P 批量投递。返回 (新建行, 跳过数, 合集标题, 总集数)。

        - import_all → 全部集数
        - episode_nos → 仅导入所选集号
        - limit → 前 limit 集
        - 已存在的分集（按 source_uri 判重）跳过，可从试跑无损续到全量。
        - 分集标题先落「合集名 P序号」占位，逐集解析时用平台元数据刷新。
        """
        try:
            url, _share_title = parse_share_input(payload.url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not looks_like_video_url(url):
            raise HTTPException(status_code=400, detail="仅视频链接支持合集批量投递")

        info = await asyncio.to_thread(probe_playlist_sync, url)
        if not info.get("is_playlist"):
            raise HTTPException(status_code=400, detail="未识别到合集/分P，请使用普通投递")
        entries = list(info.get("entries") or [])
        collection = (info.get("collection_title") or "视频合集").strip()[:500]
        total = len(entries)
        if payload.import_all:
            pass
        elif payload.episode_nos is not None:
            wanted = {int(n) for n in payload.episode_nos if int(n) > 0}
            if not wanted:
                raise HTTPException(status_code=400, detail="请至少选择一集")
            entries = [e for e in entries if int(e.get("episode_no") or 0) in wanted]
            if not entries:
                raise HTTPException(status_code=400, detail="所选集号不在该合集中")
        elif payload.limit:
            entries = entries[: payload.limit]
        else:
            raise HTTPException(
                status_code=400,
                detail="请指定要导入的分集（episode_nos）或 import_all",
            )

        # 已投递过的分集跳过（试跑 → 全量 续跑的关键）
        ep_urls = [e["url"] for e in entries]
        existing = await db.execute(
            select(Source.source_uri).where(Source.source_uri.in_(ep_urls))
        )
        seen = {u for (u,) in existing.all()}

        rows: list[Source] = []
        skipped = 0
        for e in entries:
            if e["url"] in seen:
                skipped += 1
                continue
            ep_no = int(e["episode_no"])
            row = Source(
                type="video_url",
                title=f"{collection} P{ep_no}",
                filename="",
                source_uri=e["url"],
                collection_title=collection,
                episode_no=ep_no,
                status="pending",
                stage="queued",
                progress=0,
            )
            db.add(row)
            await db.commit()
            await db.refresh(row)
            folder = _data_root() / "uploads" / str(row.id)
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "source.url").write_text(e["url"], encoding="utf-8")
            row.storage_path = str(
                (folder / "source.url").relative_to(_data_root())
            ).replace("\\", "/")
            row.stage = "saved"
            row.progress = 5
            await db.commit()
            rows.append(row)
        return rows, skipped, collection, total

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

    async def _purge_sources(self, db: AsyncSession, rows: list[Source]) -> int:
        """删除队列来源并清理 uploads / 书架索引；跳过笔记库手写笔记。"""
        rows = [row for row in rows if not (getattr(row, "vault_path", None) or "").strip()]
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

    async def clear_finished(self, db: AsyncSession) -> int:
        # 只移出「待入库 / 失败」；已入库(committed)保留来源，供知识库/书架使用
        result = await db.execute(
            select(Source).where(Source.status.in_(["ready", "failed"]))
        )
        return await self._purge_sources(db, list(result.scalars().all()))

    async def clear_failed_videos(self, db: AsyncSession) -> int:
        """批量移出失败/待补贴的视频队列项（含合集批量失败）。"""
        result = await db.execute(
            select(Source).where(
                Source.type.in_(["video_url", "video_file"]),
                Source.status.in_(["failed", "need_transcript"]),
            )
        )
        return await self._purge_sources(db, list(result.scalars().all()))

    async def clear_queue(self, db: AsyncSession) -> int:
        """清空喂养队列中所有未入库项（含进行中/失败/待入库）。

        已入库 (committed) 与笔记库手写笔记保留，不影响知识库内容。
        """
        vault_note = (Source.vault_path.is_not(None)) & (Source.vault_path != "")
        result = await db.execute(
            select(Source).where(~vault_note, Source.status != "committed")
        )
        return await self._purge_sources(db, list(result.scalars().all()))

    async def queue_control_status(self, db: AsyncSession) -> dict:
        from app.modules.sources.extract_pool import extract_concurrency, queue_snapshot
        from app.modules.sources.queue_control import is_queue_paused

        vault_note = (Source.vault_path.is_not(None)) & (Source.vault_path != "")
        pending = int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(Source)
                    .where(~vault_note, Source.status == "pending")
                )
            ).scalar_one()
        )
        running = int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(Source)
                    .where(
                        ~vault_note,
                        Source.status.in_(["extracting", "processing", "ingesting"]),
                    )
                )
            ).scalar_one()
        )
        snap = queue_snapshot()
        return {
            "paused": is_queue_paused(),
            "pending": pending,
            "running": running,
            "concurrency": extract_concurrency(),
            "queued": snap["queued"],
            "active": snap["active"],
        }

    async def list_pending_source_ids(self, db: AsyncSession) -> list[int]:
        vault_note = (Source.vault_path.is_not(None)) & (Source.vault_path != "")
        result = await db.execute(
            select(Source.id)
            .where(~vault_note, Source.status == "pending")
            .order_by(Source.id.asc())
        )
        return [int(i) for (i,) in result.all()]

    async def delete_source(self, db: AsyncSession, source_id: int) -> None:
        row = await self.get(db, source_id)
        if (getattr(row, "vault_path", None) or "").strip():
            raise HTTPException(
                status_code=400,
                detail="该条目属于笔记库手写笔记，不会出现在喂养队列操作中；请到「笔记」页管理",
            )
        if row.status == "committed":
            raise HTTPException(
                status_code=400,
                detail="该来源已入库，请到知识库删除条目；勿从喂养队列移出，以免留下搜得到但合集对不上的孤儿条目",
            )
        # 若仍有条目（异常残留），一并清掉，避免「搜索有、合集无」
        existing = await db.execute(select(Entry).where(Entry.source_id == source_id))
        for entry in existing.scalars().all():
            await self._remove_entry_tree(db, entry)
        sid = row.id
        await db.delete(row)
        await db.commit()
        folder = _data_root() / "uploads" / str(sid)
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)
        remove_source_from_library(sid)

    async def _remove_entry_tree(self, db: AsyncSession, entry: Entry) -> None:
        """删除条目及其分类/切片/批注，不改动来源状态（用于清理残留条目）。"""
        from app.modules.knowledge.models import EntryAnnotation

        links = await db.execute(
            select(EntryCategory).where(EntryCategory.entry_id == entry.id)
        )
        for link in links.scalars().all():
            await db.delete(link)
        chunks = await db.execute(select(Chunk).where(Chunk.entry_id == entry.id))
        for chunk in chunks.scalars().all():
            await db.delete(chunk)
        anns = await db.execute(
            select(EntryAnnotation).where(EntryAnnotation.entry_id == entry.id)
        )
        for ann in anns.scalars().all():
            await db.delete(ann)
        await db.delete(entry)
        await db.flush()

    async def dedupe_entries_by_source(self, db: AsyncSession) -> int:
        """同一 source_id 多条 Entry 时保留最小 id，删掉其余（不改来源状态）。"""
        rows = (
            await db.execute(
                select(Entry.source_id, func.count(Entry.id))
                .where(Entry.source_id.is_not(None))
                .group_by(Entry.source_id)
                .having(func.count(Entry.id) > 1)
            )
        ).all()
        removed = 0
        for source_id, _cnt in rows:
            if source_id is None:
                continue
            entries = (
                await db.execute(
                    select(Entry)
                    .where(Entry.source_id == int(source_id))
                    .order_by(Entry.id.asc())
                )
            ).scalars().all()
            if len(entries) < 2:
                continue
            for extra in entries[1:]:
                await self._remove_entry_tree(db, extra)
                removed += 1
        if removed:
            await db.commit()
        return removed

    async def _ensure_category(self, db: AsyncSession, name: str) -> Category:
        result = await db.execute(select(Category).where(Category.name == name))
        cat = result.scalar_one_or_none()
        if cat:
            return cat
        cat = Category(name=name, kind="tag", parent_id=None)
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

    async def resolve_original_path(self, db: AsyncSession, source_id: int) -> Path:
        """返回电子书原件路径（PDF/EPUB/TXT），供前端预览。"""
        row = await self.get(db, source_id)
        if row.type != "ebook":
            raise HTTPException(status_code=400, detail="仅电子书来源有原件预览")
        path: Path | None = None
        if row.storage_path:
            candidate = _data_root() / row.storage_path
            if candidate.is_file():
                path = candidate
        if path is None:
            folder = self._source_folder(row.id)
            for name in ("original.pdf", "original.epub", "original.txt"):
                candidate = folder / name
                if candidate.is_file():
                    path = candidate
                    break
            if path is None and folder.is_dir():
                for candidate in sorted(folder.glob("original.*")):
                    if candidate.is_file():
                        path = candidate
                        break
        if path is None:
            raise HTTPException(status_code=404, detail="原件不存在或已被清理")
        return path

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
        if len(q) > 120:
            raise HTTPException(status_code=400, detail="搜索词过长")
        text = self._read_extracted_text(row)
        offset = max(0, offset)
        limit = min(max(1, limit), 500)
        hits, total = search_text_hits(text, q, offset=offset, limit=limit)
        return PreviewSearchOut(
            query=q, total=total, offset=offset, limit=limit, hits=hits
        )

    async def _reclaim_or_clear_conflict_entry(
        self,
        db: AsyncSession,
        *,
        row: Source,
        entry: Entry,
    ) -> IngestOut | None:
        """冲突条目可合并时挂回当前来源；否则返回 None。"""
        old_sid = entry.source_id
        old_src = await db.get(Source, old_sid) if old_sid else None
        same_uri = bool(
            old_src
            and (row.source_uri or "").strip()
            and (old_src.source_uri or "").strip()
            and (row.source_uri or "").strip() == (old_src.source_uri or "").strip()
        )
        same_episode = bool(
            old_src
            and (getattr(row, "collection_title", "") or "").strip()
            and (getattr(row, "collection_title", "") or "").strip()
            == (getattr(old_src, "collection_title", "") or "").strip()
            and (getattr(row, "episode_no", 0) or 0) > 0
            and int(getattr(row, "episode_no", 0) or 0)
            == int(getattr(old_src, "episode_no", 0) or 0)
        )
        if old_src is None or same_uri or same_episode:
            entry.source_id = row.id
            if not (entry.title_key or "").strip():
                entry.title_key = normalize_title_key(
                    entry.title or row.title or row.filename or ""
                )
            row.status = "committed"
            row.stage = "committed"
            row.progress = 100
            row.error_message = ""
            collection = (getattr(row, "collection_title", "") or "").strip()[:100]
            if collection:
                category = await self._ensure_category(db, collection)
                linked = await db.execute(
                    select(EntryCategory).where(
                        EntryCategory.entry_id == entry.id,
                        EntryCategory.category_id == category.id,
                    )
                )
                if linked.scalar_one_or_none() is None:
                    db.add(
                        EntryCategory(entry_id=entry.id, category_id=category.id)
                    )
            await db.commit()
            await db.refresh(entry)
            try:
                await index_entry(db, entry.id, with_embed=False)
            except Exception:  # noqa: BLE001
                pass
            return IngestOut(
                source_id=row.id,
                entry_id=entry.id,
                title=entry.title,
                category="未命名主题",
                categories=["未命名主题"],
            )
        return None

    async def _assert_not_duplicate(
        self,
        db: AsyncSession,
        *,
        row: Source,
        title: str,
        filename: str,
        content_hash: str,
    ) -> IngestOut | None:
        """查重；可自动合并孤儿/同分集时返回 IngestOut，硬冲突抛 409。"""
        title_key = normalize_title_key(title)
        file_key = normalize_title_key(filename) if filename else ""
        source_id = int(row.id)
        is_media = (row.type or "") in {"video_url", "video_file", "url"}
        collection = (getattr(row, "collection_title", "") or "").strip()
        episode_no = int(getattr(row, "episode_no", 0) or 0)

        async def _handle_hit(entry: Entry) -> IngestOut:
            reclaimed = await self._reclaim_or_clear_conflict_entry(
                db, row=row, entry=entry
            )
            if reclaimed is not None:
                return reclaimed
            raise HTTPException(status_code=409, detail="相同内容已入库，请勿重复添加")

        if content_hash:
            hit = (
                await db.execute(
                    select(Entry).where(Entry.content_hash == content_hash).limit(1)
                )
            ).scalar_one_or_none()
            if hit is not None:
                other = await db.get(Source, hit.source_id) if hit.source_id else None
                other_ep = int(getattr(other, "episode_no", 0) or 0) if other else 0
                other_col = (
                    (getattr(other, "collection_title", "") or "").strip() if other else ""
                )
                # 合集内不同分集：正文指纹碰巧相同不拦截（ASR/错贴文案常见）
                cross_episode = bool(
                    is_media
                    and collection
                    and episode_no > 0
                    and other is not None
                    and other_col == collection
                    and other_ep > 0
                    and other_ep != episode_no
                )
                if not cross_episode:
                    return await _handle_hit(hit)

        if title_key:
            hit = (
                await db.execute(
                    select(Entry).where(Entry.title_key == title_key).limit(1)
                )
            ).scalar_one_or_none()
            if hit is not None:
                return await _handle_hit(hit)

        legacy = await db.execute(select(Entry.id, Entry.title, Entry.source_id))
        for eid, etitle, esid in legacy.all():
            if esid == source_id:
                src = await db.get(Source, source_id)
                if src and src.status == "committed":
                    raise HTTPException(
                        status_code=409, detail="该来源已有对应条目，请勿重复入库"
                    )
                stale = await db.get(Entry, eid)
                if stale:
                    await self._remove_entry_tree(db, stale)
                break
            if title_key and normalize_title_key(etitle or "") == title_key:
                stale = await db.get(Entry, eid)
                if stale:
                    return await _handle_hit(stale)

        if file_key and not is_media:
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
        return None

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
        from sqlalchemy import update

        row = await self.get(db, source_id)
        if row.status == "committed":
            raise HTTPException(status_code=409, detail="该来源已入库，请勿重复操作")
        if row.status == "ingesting":
            raise HTTPException(status_code=409, detail="该来源正在入库，请稍候")
        if row.status != "ready":
            raise HTTPException(
                status_code=400,
                detail=f"仅 ready 状态可入库，当前为 {row.status}",
            )

        # 原子占用：并发/双击时只有一路能把 ready → ingesting
        claimed = await db.execute(
            update(Source)
            .where(Source.id == source_id, Source.status == "ready")
            .values(status="ingesting", stage="ingesting", progress=95, error_message="")
        )
        await db.commit()
        if claimed.rowcount != 1:
            row = await self.get(db, source_id)
            if row.status == "committed":
                raise HTTPException(status_code=409, detail="该来源已入库，请勿重复操作")
            if row.status == "ingesting":
                raise HTTPException(status_code=409, detail="该来源正在入库，请稍候")
            raise HTTPException(
                status_code=400,
                detail=f"仅 ready 状态可入库，当前为 {row.status}",
            )

        row = await self.get(db, source_id)
        try:
            existing = await db.execute(
                select(Entry).where(Entry.source_id == source_id).limit(1)
            )
            stale_entry = existing.scalar_one_or_none()
            if stale_entry:
                # 喂养队列删来源后条目可能残留，或来源 id 被复用时会出现「条目在、来源未 committed」
                await self._remove_entry_tree(db, stale_entry)

            text = self._read_extracted_text(row).strip()
            if not text:
                raise HTTPException(status_code=400, detail="正文为空，无法入库")

            title = (row.title or row.filename or f"来源 #{row.id}").strip()[:500]
            digest = content_fingerprint(text)
            reclaimed = await self._assert_not_duplicate(
                db,
                row=row,
                title=title,
                filename=row.filename or "",
                content_hash=digest,
            )
            if reclaimed is not None:
                return reclaimed

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
            linked_category_ids: set[int] = set()
            for tag in tags:
                category = await self._ensure_category(db, tag)
                if category.id in linked_category_ids:
                    continue
                linked_category_ids.add(category.id)
                db.add(EntryCategory(entry_id=entry.id, category_id=category.id))
            # 合集分集：额外挂到「合集名」分类，知识页按合集收拢、对话可按合集限定检索
            # 名称截断到 100（Category.name 上限）；勿经 is_good_tag，否则会长标题被侧栏清理误删
            collection = (getattr(row, "collection_title", "") or "").strip()[:100]
            if collection:
                category = await self._ensure_category(db, collection)
                if category.id not in linked_category_ids:
                    db.add(EntryCategory(entry_id=entry.id, category_id=category.id))

            row.status = "committed"
            row.stage = "committed"
            row.progress = 100
            row.error_message = ""
            await db.commit()
            await db.refresh(entry)
        except HTTPException:
            try:
                await db.rollback()
                failed = await self.get(db, source_id)
                if failed.status == "ingesting":
                    failed.status = "ready"
                    failed.stage = "extracted"
                    failed.progress = 100
                    failed.error_message = ""
                    await db.commit()
            except Exception:  # noqa: BLE001
                pass
            raise
        except Exception as exc:
            # 占用后失败：释放回 ready，避免卡在 ingesting
            try:
                await db.rollback()
                failed = await self.get(db, source_id)
                if failed.status == "ingesting":
                    failed.status = "ready"
                    failed.stage = "extracted"
                    failed.progress = 100
                    failed.error_message = ""
                    await db.commit()
            except Exception:  # noqa: BLE001
                pass
            from sqlalchemy.exc import IntegrityError

            if isinstance(exc, IntegrityError):
                raise HTTPException(
                    status_code=409, detail="该来源已有对应条目，请勿重复入库"
                ) from exc
            raise

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
                # 合集分集：用平台元数据把占位标题刷新为真实分集标题（如「p23 藏象学说-肝」）
                if (getattr(row, "episode_no", 0) or 0) > 0:
                    try:
                        meta_title = await asyncio.to_thread(
                            fetch_video_title_sync, video_url
                        )
                        if meta_title and meta_title != (row.title or ""):
                            row.title = meta_title[:500]
                            await db.commit()
                    except Exception:  # noqa: BLE001
                        pass
                asr_cfg = await settings_ai_service.asr_config(db)
                allow_local_audio = asr_cfg.get("allow_local_audio") == "1"
                # 抖音几乎必无外挂字幕，跳过字幕探测直接走 ASR，省一次 yt-dlp
                skip_subs = _is_douyin_url(video_url)
                sub_exc: ValueError | None = None
                if skip_subs:
                    sub_exc = ValueError(
                        "该视频没有可下载字幕轨（抖音多数如此），将改用音轨语音转写。"
                    )
                else:
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
                    except ValueError as exc:
                        sub_exc = exc
                if sub_exc is not None:
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

    def _assert_editable_note(self, row: Source) -> None:
        if row.type != "note":
            raise HTTPException(status_code=400, detail="仅笔记（Markdown/文本）可在应用内编辑")
        name = (row.filename or row.storage_path or "").strip()
        suffix = Path(name).suffix.lower()
        if suffix and suffix not in {".md", ".markdown", ".txt"}:
            raise HTTPException(status_code=400, detail="仅笔记（Markdown/文本）可在应用内编辑")

    async def get_content(self, db: AsyncSession, source_id: int) -> SourceContentOut:
        row = await self.get(db, source_id)
        self._assert_editable_note(row)
        content = ""
        if row.storage_path:
            path = _data_root() / row.storage_path
            if path.is_file():
                content = path.read_text(encoding="utf-8", errors="ignore")
        if not content.strip() and row.text_path:
            path = _data_root() / row.text_path
            if path.is_file():
                content = path.read_text(encoding="utf-8", errors="ignore")
        return SourceContentOut(
            source_id=row.id,
            title=(row.title or row.filename or f"来源 #{row.id}"),
            content=content,
            format="markdown",
            status=row.status or "",
            editable=True,
        )

    async def update_content(
        self,
        db: AsyncSession,
        source_id: int,
        payload: SourceContentIn,
    ) -> SourceContentOut:
        row = await self.get(db, source_id)
        self._assert_editable_note(row)
        content = payload.content.replace("\r\n", "\n")
        if not content.strip():
            raise HTTPException(status_code=400, detail="内容不能为空")

        title = (payload.title or "").strip()
        if not title:
            title = (
                content.splitlines()[0][:80].lstrip("# ").strip()
                or (row.title or "未命名笔记")
            )
        title = title[:500]

        folder = _data_root() / "uploads" / str(row.id)
        folder.mkdir(parents=True, exist_ok=True)

        dest = folder / "original.md"
        if row.storage_path:
            existing = _data_root() / row.storage_path
            if existing.is_file() and existing.suffix.lower() in {".txt", ".markdown"}:
                dest = existing
        dest.write_text(content, encoding="utf-8")

        text_file = folder / "extracted.txt"
        text_file.write_text(content, encoding="utf-8")

        row.title = title
        row.filename = row.filename or dest.name
        if not str(row.filename).lower().endswith((".md", ".markdown", ".txt")):
            row.filename = "paste.md"
        row.storage_path = str(dest.relative_to(_data_root())).replace("\\", "/")
        row.text_path = str(text_file.relative_to(_data_root())).replace("\\", "/")
        row.char_count = len(content)
        row.error_message = ""
        if row.status != "committed":
            row.status = "ready"
            row.stage = "extracted"
            row.progress = 100
        else:
            row.stage = "edited"
            row.progress = 100

        await db.commit()
        await db.refresh(row)

        if row.status == "committed":
            result = await db.execute(select(Entry).where(Entry.source_id == row.id).limit(1))
            entry = result.scalar_one_or_none()
            if entry:
                entry.title = title
                entry.title_key = normalize_title_key(title)
                entry.content_hash = content_fingerprint(content)
                if not (entry.summary or "").strip():
                    entry.summary = content[:SUMMARY_CHARS].strip()
                await db.commit()
                try:
                    await index_entry(db, entry.id, with_embed=True)
                except Exception:
                    pass

        try:
            await library_service.sync_source(db, row.id)
        except Exception:
            pass

        return SourceContentOut(
            source_id=row.id,
            title=row.title,
            content=content,
            format="markdown",
            status=row.status or "",
            editable=True,
        )


def urlparse_title(url: str) -> str:
    from urllib.parse import urlparse

    host = urlparse(url).hostname or "链接"
    return f"{host} 材料"


sources_service = SourcesService()