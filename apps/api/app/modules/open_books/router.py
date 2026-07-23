from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import Response

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


def _safe_filename_stem(name: str) -> str:
    import re

    s = re.sub(r'[\\/:*?"<>|\r\n]+', "_", (name or "").strip())
    s = re.sub(r"_+", "_", s).strip(" ._")
    return (s[:60] or "book")


def _attachment_name(*, title: str, original_filename: str) -> str:
    """书名 + 时间戳，保留原扩展名。"""
    ext = ""
    if "." in (original_filename or ""):
        ext = original_filename.rsplit(".", 1)[-1].lower()
    if ext not in {"txt", "epub", "md", "html", "htm"}:
        ext = "txt"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = _safe_filename_stem(title) or "book"
    return f"{stem}_{stamp}.{ext}"


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


@router.get(
    "/file",
    summary="另存为：拉取电子书文件到本机",
    description="直接返回文件流，不进入喂养队列。",
)
async def download_open_book_file(
    source: str = Query(DEFAULT_SOURCE, description="书源 id"),
    book_id: str = Query(..., min_length=1, max_length=500, description="源内书籍 id"),
    title_hint: str = Query("", max_length=200, description="可选：前端传入的书名，用于文件名"),
) -> Response:
    try:
        data, filename, title = await open_books_service.fetch_file(
            source=source, book_id=book_id
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"下载失败：{exc}") from exc

    display_title = (title_hint or title or "").strip() or "book"
    safe_name = _attachment_name(title=display_title, original_filename=filename or "book.txt")
    ascii_name = safe_name.encode("ascii", "ignore").decode("ascii") or f"book_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    encoded = quote(safe_name)
    media = (
        "application/epub+zip"
        if safe_name.lower().endswith(".epub")
        else "text/plain; charset=utf-8"
    )
    return Response(
        content=data,
        media_type=media,
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}"
            ),
            "X-Kongku-Filename": encoded,
        },
    )


@router.post(
    "/import",
    response_model=OpenBookImportJobOut,
    summary="开始下载公版书到喂养队列（异步，可查进度）",
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
