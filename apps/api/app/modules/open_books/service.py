"""公版书投递：多源搜索，异步下载并写入 sources。"""

from __future__ import annotations

import logging

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import database as db_mod
from app.modules.open_books.jobs import create_job, get_job, job_to_dict, update_job
from app.modules.open_books.providers import DEFAULT_SOURCE, get_provider, list_sources
from app.modules.open_books.schemas import (
    FeedOpenBookSettingsOut,
    FeedOpenBookSettingsUpdate,
    OpenBookImportJobOut,
    OpenBookSearchOut,
    OpenBookSourcesOut,
)
from app.modules.open_books.settings_store import (
    MIRROR_PRESETS,
    load_feed_settings,
    resolve_ctext_api_key,
    resolve_mirror_repo,
    save_feed_settings,
)
from app.modules.sources.service import sources_service
from app.modules.sources.tasks import run_extract_job, run_extract_then_ingest_job

logger = logging.getLogger(__name__)


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "***"
    return f"{key[:3]}***{key[-4:]}"


class OpenBooksService:
    def get_settings(self) -> FeedOpenBookSettingsOut:
        cfg = load_feed_settings()
        key = resolve_ctext_api_key()
        repo, ref = resolve_mirror_repo()
        return FeedOpenBookSettingsOut(
            open_ebook_direct_ingest=bool(cfg.get("open_ebook_direct_ingest")),
            ctext_api_key_masked=_mask_key(key),
            ctext_configured=bool(key),
            mirror_repo=repo,
            mirror_ref=ref,
            mirror_presets=list(MIRROR_PRESETS),
        )

    def update_settings(self, payload: FeedOpenBookSettingsUpdate) -> FeedOpenBookSettingsOut:
        try:
            save_feed_settings(
                open_ebook_direct_ingest=payload.open_ebook_direct_ingest,
                ctext_api_key=payload.ctext_api_key,
                mirror_repo=payload.mirror_repo,
                mirror_ref=payload.mirror_ref,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return self.get_settings()

    def sources(self) -> OpenBookSourcesOut:
        return OpenBookSourcesOut(items=list_sources(), default_source=DEFAULT_SOURCE)

    async def search(self, query: str, *, source: str, page: int = 1) -> OpenBookSearchOut:
        provider = get_provider(source)
        items, total = await provider.search(query, page=page)
        return OpenBookSearchOut(
            query=query.strip(),
            source=provider.info.id,
            total=total,
            items=items,
            notice=provider.info.description
            + " 非全网任意图书；下载后进入喂养队列，默认需抽取后才能预览与入库。",
        )

    def get_job(self, job_id: str) -> OpenBookImportJobOut:
        job = get_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="下载任务不存在或已过期")
        return OpenBookImportJobOut(**job_to_dict(job))

    async def start_import(
        self,
        *,
        source: str,
        book_id: str,
        direct_ingest: bool,
    ) -> OpenBookImportJobOut:
        settings = self.get_settings()
        want_direct = bool(direct_ingest)
        if want_direct and not settings.open_ebook_direct_ingest:
            raise HTTPException(
                status_code=400,
                detail="未开启「公版书直接入库」。请到设置 → 喂养中开启，或仅使用「下载」。",
            )
        # 预先校验书源存在
        get_provider(source)
        job = create_job(direct_ingest=want_direct)
        update_job(job.id, status="pending", progress=1, message="已创建下载任务…")
        return OpenBookImportJobOut(**job_to_dict(job))

    async def run_import_job(
        self,
        *,
        job_id: str,
        source: str,
        book_id: str,
        direct_ingest: bool,
    ) -> None:
        try:
            update_job(job_id, status="running", progress=8, message="正在连接书源…")
            provider = get_provider(source)
            update_job(job_id, progress=20, message="正在下载电子书…")
            data, filename, title = await provider.fetch(str(book_id))
            update_job(
                job_id,
                progress=70,
                message="下载完成，正在写入喂养队列…",
                title=title,
                filename=filename,
            )

            factory = db_mod.SessionLocal
            if factory is None:
                db_mod.init_engine_from_config()
                factory = db_mod.SessionLocal
            if factory is None:
                raise RuntimeError("数据库引擎未初始化")

            async with factory() as db:
                row = await sources_service.create_from_bytes(
                    db,
                    data=data,
                    filename=filename,
                    title=title,
                    source_type="ebook",
                )
                source_id = row.id

            update_job(
                job_id,
                progress=90,
                message="已加入喂养队列，正在后台抽取…",
                source_id=source_id,
            )

            if direct_ingest:
                await run_extract_then_ingest_job(source_id)
                update_job(
                    job_id,
                    status="done",
                    progress=100,
                    message="下载完成，已抽取并入库",
                    source_id=source_id,
                )
            else:
                await run_extract_job(source_id)
                update_job(
                    job_id,
                    status="done",
                    progress=100,
                    message="下载完成，已加入喂养队列",
                    source_id=source_id,
                )
        except HTTPException as exc:
            detail = str(exc.detail)
            update_job(job_id, status="failed", progress=100, message=detail, error=detail)
            logger.warning("open-book import failed job=%s: %s", job_id, detail)
        except Exception as exc:  # noqa: BLE001
            detail = f"下载失败：{exc}"
            update_job(job_id, status="failed", progress=100, message=detail, error=detail)
            logger.exception("open-book import failed job=%s", job_id)


open_books_service = OpenBooksService()
