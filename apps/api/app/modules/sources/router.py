from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.sources.schemas import (
    IngestOut,
    IngestReadyOut,
    PasteIn,
    PreviewSearchOut,
    SourceContentIn,
    SourceContentOut,
    SourceCuesOut,
    SourceListOut,
    SourceOut,
    SourcePreviewOut,
    TranscriptIn,
    UrlBatchIn,
    UrlBatchOut,
    UrlIn,
    UrlProbeIn,
    UrlProbeOut,
)
from app.modules.sources.queue_control import set_queue_paused
from app.modules.sources.service import sources_service
from app.modules.sources.tasks import schedule_extract

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
    "/queue/failed-videos",
    summary="清空失败的视频队列项",
)
async def clear_failed_videos(db: AsyncSession = Depends(get_db)) -> dict:
    n = await sources_service.clear_failed_videos(db)
    return {"removed": n}


@router.delete(
    "/queue/all",
    summary="清空整个喂养队列",
    description=(
        "移出所有未入库的队列项（等待中/解析中/待入库/失败等），并清理 uploads。"
        "已入库来源与知识库条目、笔记库手写笔记不受影响。"
    ),
)
async def clear_queue(db: AsyncSession = Depends(get_db)) -> dict:
    n = await sources_service.clear_queue(db)
    return {"removed": n}


@router.get(
    "/queue/control",
    summary="解析队列运行状态",
)
async def get_queue_control(db: AsyncSession = Depends(get_db)) -> dict:
    return await sources_service.queue_control_status(db)


@router.post(
    "/queue/pause",
    summary="暂停解析队列",
    description="已在进行中的任务会跑完；等待中的项暂不开始，直到点「开始」。",
)
async def pause_queue(db: AsyncSession = Depends(get_db)) -> dict:
    set_queue_paused(True)
    status = await sources_service.queue_control_status(db)
    return {**status, "ok": True}


@router.post(
    "/queue/start",
    summary="开始 / 继续解析队列",
    description="取消暂停，并调度所有 status=pending 的来源开始解析。",
)
async def start_queue(
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> dict:
    set_queue_paused(False)
    ids = await sources_service.list_pending_source_ids(db)
    started = 0
    for sid in ids:
        if schedule_extract(background_tasks, sid):
            started += 1
    status = await sources_service.queue_control_status(db)
    return {**status, "ok": True, "started": started}


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
    schedule_extract(background_tasks, row.id)
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
    schedule_extract(background_tasks, row.id)
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
    schedule_extract(background_tasks, row.id)
    return sources_service.to_out(row)


@router.post(
    "/url/probe",
    response_model=UrlProbeOut,
    summary="探测链接是否为合集/分P",
    description="不落库。返回 is_playlist / collection_title / total / entries，供前端选集。",
)
async def probe_url(payload: UrlProbeIn) -> UrlProbeOut:
    return await sources_service.probe_url(UrlIn(url=payload.url))


@router.post(
    "/url/batch",
    response_model=UrlBatchOut,
    summary="合集/分P 批量投递",
    description=(
        "import_all 导入全部；或 episode_nos 指定集号（可多选）；或 limit 前 N 集。"
        "已投递过的分集自动跳过（可从试跑续到全量）。"
        "后台任务按提交顺序串行解析，单集失败不影响其他集。"
    ),
)
async def url_batch(
    payload: UrlBatchIn,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> UrlBatchOut:
    rows, skipped, collection, total = await sources_service.create_url_batch(db, payload)
    for row in rows:
        schedule_extract(background_tasks, row.id)
    return UrlBatchOut(
        collection_title=collection,
        total=total,
        created=len(rows),
        skipped=skipped,
        source_ids=[r.id for r in rows],
    )


@router.get(
    "/{source_id}",
    response_model=SourceOut,
    summary="单个来源详情",
)
async def get_source(source_id: int, db: AsyncSession = Depends(get_db)) -> SourceOut:
    row = await sources_service.get(db, source_id)
    return sources_service.to_out(row)


@router.get(
    "/{source_id}/content",
    response_model=SourceContentOut,
    summary="读取笔记 Markdown 正文",
    description="仅笔记类型；优先 original 原件，回退 extracted.txt。",
)
async def get_source_content(
    source_id: int, db: AsyncSession = Depends(get_db)
) -> SourceContentOut:
    return await sources_service.get_content(db, source_id)


@router.put(
    "/{source_id}/content",
    response_model=SourceContentOut,
    summary="保存笔记 Markdown 正文",
    description="写回原件与 extracted.txt；已入库则重切片。",
)
async def put_source_content(
    source_id: int,
    payload: SourceContentIn,
    db: AsyncSession = Depends(get_db),
) -> SourceContentOut:
    return await sources_service.update_content(db, source_id, payload)


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


@router.get(
    "/{source_id}/cues",
    response_model=SourceCuesOut,
    summary="视频跟读时间轴",
    description="返回句级时间轴与音轨是否就绪，供前端音频跟读高亮。",
)
async def get_source_cues(
    source_id: int, db: AsyncSession = Depends(get_db)
) -> SourceCuesOut:
    return await sources_service.get_cues(db, source_id)


@router.get(
    "/{source_id}/media",
    summary="视频跟读音轨",
    description="返回提取时缓存的音轨文件（支持 Range）。",
)
async def get_source_media(
    source_id: int, db: AsyncSession = Depends(get_db)
) -> FileResponse:
    path = await sources_service.resolve_media_path(db, source_id)
    suffix = path.suffix.lower()
    media_types = {
        ".m4a": "audio/mp4",
        ".mp3": "audio/mpeg",
        ".webm": "audio/webm",
        ".opus": "audio/ogg",
        ".ogg": "audio/ogg",
        ".wav": "audio/wav",
        ".aac": "audio/aac",
    }
    return FileResponse(
        path,
        media_type=media_types.get(suffix, "application/octet-stream"),
        filename=path.name,
    )


@router.get(
    "/{source_id}/original",
    summary="电子书原件",
    description="返回上传的 PDF/EPUB/TXT 原件（支持 Range），供 PDF 预览等使用。",
)
async def get_source_original(
    source_id: int, db: AsyncSession = Depends(get_db)
) -> FileResponse:
    path = await sources_service.resolve_original_path(db, source_id)
    suffix = path.suffix.lower()
    media_types = {
        ".pdf": "application/pdf",
        ".epub": "application/epub+zip",
        ".txt": "text/plain; charset=utf-8",
    }
    return FileResponse(
        path,
        media_type=media_types.get(suffix, "application/octet-stream"),
        filename=path.name,
    )


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
    schedule_extract(background_tasks, row.id)
    return sources_service.to_out(row)
