from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.knowledge.schemas import (
    AnnotationCreate,
    AnnotationListOut,
    AnnotationOut,
    AnnotationUpdate,
    BookshelfListOut,
    CategoryListOut,
    EntryDetailOut,
    EntryListOut,
    EntryPreviewOut,
    ReindexOut,
)
from app.modules.knowledge.service import knowledge_service
from app.modules.knowledge.index import reindex_all, reindex_missing
from app.modules.sources.schemas import PreviewSearchOut

router = APIRouter(tags=["知识浏览"])


@router.get(
    "/categories",
    response_model=CategoryListOut,
    summary="分类列表（含条目计数）",
)
async def list_categories(db: AsyncSession = Depends(get_db)) -> CategoryListOut:
    return await knowledge_service.list_categories(db)


@router.get(
    "/bookshelf",
    response_model=BookshelfListOut,
    summary="确认书籍书架",
    description="仅返回 book_kind=confirmed 的电子书（公版书库导入 / 本地 EPUB·PDF）。本地 TXT 可能为书，不上架。",
)
async def list_bookshelf(db: AsyncSession = Depends(get_db)) -> BookshelfListOut:
    return await knowledge_service.list_bookshelf(db)


@router.get(
    "/entries",
    response_model=EntryListOut,
    summary="知识条目列表",
)
async def list_entries(
    q: str = Query("", description="标题/摘要关键词"),
    category: str = Query("", description="按分类名过滤"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
) -> EntryListOut:
    return await knowledge_service.list_entries(
        db, q=q, category=category, page=page, page_size=page_size
    )


@router.get(
    "/entries/{entry_id}",
    response_model=EntryDetailOut,
    summary="条目详情",
)
async def get_entry(entry_id: int, db: AsyncSession = Depends(get_db)) -> EntryDetailOut:
    return await knowledge_service.get_entry(db, entry_id)


@router.get(
    "/entries/{entry_id}/preview",
    response_model=EntryPreviewOut,
    summary="条目正文预览",
    description="按段读取关联来源的抽取正文，便于前端弹窗浏览。",
)
async def preview_entry(
    entry_id: int,
    offset: int = Query(0, ge=0),
    limit: int = Query(12000, ge=1, le=50000),
    db: AsyncSession = Depends(get_db),
) -> EntryPreviewOut:
    return await knowledge_service.get_preview(db, entry_id, offset=offset, limit=limit)


@router.get(
    "/entries/{entry_id}/preview/search",
    response_model=PreviewSearchOut,
    summary="在条目正文中搜索",
    description="返回匹配位置，前端可跳转定位并高亮。",
)
async def search_entry_preview(
    entry_id: int,
    q: str = Query(..., min_length=1, max_length=80),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> PreviewSearchOut:
    return await knowledge_service.search_preview(
        db, entry_id, query=q, offset=offset, limit=limit
    )


@router.get(
    "/entries/{entry_id}/annotations",
    response_model=AnnotationListOut,
    summary="条目笔记列表",
)
async def list_annotations(
    entry_id: int, db: AsyncSession = Depends(get_db)
) -> AnnotationListOut:
    return await knowledge_service.list_annotations(db, entry_id)


@router.post(
    "/entries/{entry_id}/annotations",
    response_model=AnnotationOut,
    summary="创建划选高亮/笔记",
)
async def create_annotation(
    entry_id: int,
    payload: AnnotationCreate,
    db: AsyncSession = Depends(get_db),
) -> AnnotationOut:
    return await knowledge_service.create_annotation(db, entry_id, payload)


@router.patch(
    "/annotations/{ann_id}",
    response_model=AnnotationOut,
    summary="更新笔记",
)
async def update_annotation(
    ann_id: int,
    payload: AnnotationUpdate,
    db: AsyncSession = Depends(get_db),
) -> AnnotationOut:
    return await knowledge_service.update_annotation(db, ann_id, payload)


@router.delete(
    "/annotations/{ann_id}",
    status_code=204,
    summary="删除笔记",
)
async def delete_annotation(ann_id: int, db: AsyncSession = Depends(get_db)) -> Response:
    await knowledge_service.delete_annotation(db, ann_id)
    return Response(status_code=204)


@router.delete(
    "/entries/{entry_id}",
    status_code=204,
    summary="删除知识条目",
    description="硬删条目与分类关联；若有对应喂养来源，会将其恢复为 ready，可再次入库。",
)
async def delete_entry(entry_id: int, db: AsyncSession = Depends(get_db)) -> Response:
    await knowledge_service.delete_entry(db, entry_id)
    return Response(status_code=204)


@router.post(
    "/knowledge/reindex",
    response_model=ReindexOut,
    summary="重建对话检索切片",
    description="默认仅为尚无切片的条目建索引；mode=all 时全量重建。",
)
async def reindex_knowledge(
    mode: str = Query("missing", pattern="^(missing|all)$"),
    db: AsyncSession = Depends(get_db),
) -> ReindexOut:
    if mode == "all":
        stats = await reindex_all(db, with_embed=True)
    else:
        stats = await reindex_missing(db, with_embed=True)
    return ReindexOut(entries=stats["entries"], chunks=stats["chunks"], mode=mode)
