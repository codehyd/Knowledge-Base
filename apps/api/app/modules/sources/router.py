from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.sources.schemas import (
    IngestOut,
    IngestReadyOut,
    PasteIn,
    PreviewSearchOut,
    SourceListOut,
    SourceOut,
    SourcePreviewOut,
    TranscriptIn,
    UrlIn,
)
from app.modules.sources.service import sources_service
from app.modules.sources.tasks import run_extract_job

router = APIRouter(prefix="/sources", tags=["喂养投递"])


@router.get(
    "",
    response_model=SourceListOut,
    summary="喂养队列列表",
)
async def list_sources(db: AsyncSession = Depends(get_db)) -> SourceListOut:
    rows, total = await sources_service.list_sources(db)
    return SourceListOut(items=[sources_service.to_out(r) for r in rows], total=total)


@router.delete(
    "/queue/finished",
    summary="清空已完成/失败的队列项",
)
async def clear_finished(db: AsyncSession = Depends(get_db)) -> dict:
    n = await sources_service.clear_finished(db)
    return {"removed": n}


@router.delete(
    "/{source_id}",
    summary="删除队列中的单条来源",
    description="从喂养队列移除该项，并清理对应上传文件。已入库的知识条目不受影响。",
)
async def delete_source(source_id: int, db: AsyncSession = Depends(get_db)) -> dict:
    await sources_service.delete_source(db, source_id)
    return {"ok": True, "id": source_id}


@router.post(
    "/ingest-ready",
    response_model=IngestReadyOut,
    summary="批量入库所有 ready 来源",
    description="将当前队列中 status=ready 的来源写入 entries，并标记为 committed。",
)
async def ingest_ready(db: AsyncSession = Depends(get_db)) -> IngestReadyOut:
    ingested, skipped, failed = await sources_service.ingest_ready(db)
    return IngestReadyOut(ingested=ingested, skipped=skipped, failed=failed)


@router.post(
    "/upload",
    response_model=SourceOut,
    summary="上传电子书或笔记文件",
)
async def upload_source(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    type: str = Form("ebook"),
    db: AsyncSession = Depends(get_db),
) -> SourceOut:
    row = await sources_service.create_upload(db, file=file, source_type=type)
    background_tasks.add_task(run_extract_job, row.id)
    return sources_service.to_out(row)


@router.post(
    "/paste",
    response_model=SourceOut,
    summary="粘贴笔记正文",
)
async def paste_source(
    payload: PasteIn,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> SourceOut:
    row = await sources_service.create_paste(db, payload)
    background_tasks.add_task(run_extract_job, row.id)
    return sources_service.to_out(row)


@router.post(
    "/url",
    response_model=SourceOut,
    summary="投递视频或网页链接",
    description="视频优先自动拉字幕；网页抽正文。失败可补贴文案。",
)
async def url_source(
    payload: UrlIn,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> SourceOut:
    row = await sources_service.create_url(db, payload)
    background_tasks.add_task(run_extract_job, row.id)
    return sources_service.to_out(row)


@router.get(
    "/{source_id}",
    response_model=SourceOut,
    summary="单个来源详情",
)
async def get_source(source_id: int, db: AsyncSession = Depends(get_db)) -> SourceOut:
    row = await sources_service.get(db, source_id)
    return sources_service.to_out(row)


@router.get(
    "/{source_id}/preview",
    response_model=SourcePreviewOut,
    summary="预览抽取正文",
    description="读取 extracted.txt 片段；支持 offset/limit 分段加载。",
)
async def preview_source(
    source_id: int,
    offset: int = 0,
    limit: int = 12000,
    db: AsyncSession = Depends(get_db),
) -> SourcePreviewOut:
    return await sources_service.get_preview(db, source_id, offset=offset, limit=limit)


@router.get(
    "/{source_id}/preview/search",
    response_model=PreviewSearchOut,
    summary="在抽取正文中搜索",
    description="返回匹配位置 offset，便于前端跳转定位。",
)
async def search_source_preview(
    source_id: int,
    q: str,
    offset: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
) -> PreviewSearchOut:
    return await sources_service.search_preview(
        db, source_id, query=q, offset=offset, limit=limit
    )


@router.post(
    "/{source_id}/ingest",
    response_model=IngestOut,
    summary="将来源入库为知识条目",
    description="仅 status=ready 可入库；写入 Entry + 主题分类，source 标记 committed。",
)
async def ingest_source(source_id: int, db: AsyncSession = Depends(get_db)) -> IngestOut:
    return await sources_service.ingest(db, source_id)


@router.post(
    "/{source_id}/transcript",
    response_model=SourceOut,
    summary="补贴文案（链接自动提取失败时）",
)
async def post_transcript(
    source_id: int,
    payload: TranscriptIn,
    db: AsyncSession = Depends(get_db),
) -> SourceOut:
    row = await sources_service.attach_transcript(db, source_id, payload)
    return sources_service.to_out(row)


@router.post(
    "/{source_id}/retry",
    response_model=SourceOut,
    summary="失败重试抽取",
)
async def retry_source(
    source_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> SourceOut:
    row = await sources_service.get(db, source_id)
    row.status = "pending"
    row.stage = "queued"
    row.progress = 0
    row.error_message = ""
    await db.commit()
    await db.refresh(row)
    background_tasks.add_task(run_extract_job, row.id)
    return sources_service.to_out(row)
