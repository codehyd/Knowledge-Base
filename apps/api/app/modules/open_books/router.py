from fastapi import APIRouter, BackgroundTasks, HTTPException, Query

from app.modules.open_books.providers import DEFAULT_SOURCE
from app.modules.open_books.schemas import (
    FeedOpenBookSettingsOut,
    FeedOpenBookSettingsUpdate,
    OpenBookImportIn,
    OpenBookImportJobOut,
    OpenBookSearchOut,
    OpenBookSourcesOut,
)
from app.modules.open_books.service import open_books_service

router = APIRouter(prefix="/open-books", tags=["公版电子书"])


@router.get(
    "/settings",
    response_model=FeedOpenBookSettingsOut,
    summary="读取公版书喂养设置",
)
async def get_open_book_settings() -> FeedOpenBookSettingsOut:
    return open_books_service.get_settings()


@router.put(
    "/settings",
    response_model=FeedOpenBookSettingsOut,
    summary="更新公版书喂养设置",
)
async def put_open_book_settings(payload: FeedOpenBookSettingsUpdate) -> FeedOpenBookSettingsOut:
    return open_books_service.update_settings(payload)


@router.get(
    "/sources",
    response_model=OpenBookSourcesOut,
    summary="可用公版书源列表",
)
async def list_open_book_sources() -> OpenBookSourcesOut:
    return open_books_service.sources()


@router.get(
    "/search",
    response_model=OpenBookSearchOut,
    summary="搜索公版/开放电子书",
)
async def search_open_books(
    q: str = Query(..., min_length=1, max_length=200, description="书名或作者"),
    source: str = Query(DEFAULT_SOURCE, description="书源 id"),
    page: int = Query(1, ge=1, le=50),
) -> OpenBookSearchOut:
    return await open_books_service.search(q, source=source, page=page)


@router.post(
    "/import",
    response_model=OpenBookImportJobOut,
    summary="开始下载公版书（异步，可查进度）",
)
async def import_open_book(
    payload: OpenBookImportIn,
    background_tasks: BackgroundTasks,
) -> OpenBookImportJobOut:
    try:
        job = await open_books_service.start_import(
            source=payload.source,
            book_id=payload.book_id,
            direct_ingest=payload.direct_ingest,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"下载失败：{exc}") from exc

    background_tasks.add_task(
        open_books_service.run_import_job,
        job_id=job.job_id,
        source=payload.source,
        book_id=payload.book_id,
        direct_ingest=payload.direct_ingest,
    )
    return job


@router.get(
    "/jobs/{job_id}",
    response_model=OpenBookImportJobOut,
    summary="查询公版书下载进度",
)
async def get_import_job(job_id: str) -> OpenBookImportJobOut:
    return open_books_service.get_job(job_id)
