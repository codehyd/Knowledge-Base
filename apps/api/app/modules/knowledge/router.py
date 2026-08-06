from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.knowledge.schemas import (
    AnnotationCreate,
    AnnotationExpandIn,
    AnnotationListOut,
    AnnotationOut,
    AnnotationPromoteIn,
    AnnotationUpdate,
    BookshelfListOut,
    CategoryCreate,
    CategoryListOut,
    CategoryOut,
    CategoryUpdate,
    CollectionDeleteIn,
    CollectionDeleteOut,
    CollectionListOut,
    EntryBatchDeleteIn,
    EntryBatchDeleteOut,
    EntryCategoriesIn,
    EntryDetailOut,
    EntryListOut,
    EntryPreviewOut,
    MediaListOut,
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
    description="含人工分类（kind=domain）与自动标签（kind=tag）。domain.count 为直接挂靠该分类的条目数。",
)
async def list_categories(db: AsyncSession = Depends(get_db)) -> CategoryListOut:
    return await knowledge_service.list_categories(db)


@router.post(
    "/categories",
    response_model=CategoryOut,
    summary="创建用户顶级分类",
)
async def create_category(
    payload: CategoryCreate, db: AsyncSession = Depends(get_db)
) -> CategoryOut:
    return await knowledge_service.create_domain(db, payload)


@router.patch(
    "/categories/{category_id}",
    response_model=CategoryOut,
    summary="更新分类",
    description="可重命名；主题标签可设置 parent_id 挂到顶级域（null 取消挂靠）。",
)
async def update_category(
    category_id: int,
    payload: CategoryUpdate,
    db: AsyncSession = Depends(get_db),
) -> CategoryOut:
    return await knowledge_service.update_category(db, category_id, payload)


@router.delete(
    "/categories/{category_id}",
    summary="删除用户顶级分类",
    description="仅允许删除 kind=domain；其下主题标签会解除挂靠，不会删除。",
    status_code=204,
)
async def delete_category(
    category_id: int, db: AsyncSession = Depends(get_db)
) -> Response:
    await knowledge_service.delete_domain(db, category_id)
    return Response(status_code=204)


@router.get(
    "/bookshelf",
    response_model=BookshelfListOut,
    summary="确认书籍书架",
    description="仅返回 book_kind=confirmed 的电子书（公版书库导入 / 本地 EPUB·PDF）。本地 TXT 可能为书，不上架。",
)
async def list_bookshelf(db: AsyncSession = Depends(get_db)) -> BookshelfListOut:
    return await knowledge_service.list_bookshelf(db)


@router.get(
    "/media",
    response_model=MediaListOut,
    summary="视频与链接媒体库",
    description="展示 video_url / url 来源（已抽取或已入库），可预览转写文案。",
)
async def list_media(db: AsyncSession = Depends(get_db)) -> MediaListOut:
    return await knowledge_service.list_media(db)


@router.get(
    "/collections",
    response_model=CollectionListOut,
    summary="已入库视频合集",
    description="按合集名聚合已入库分集，供知识页侧栏以文件夹形式展开。",
)
async def list_collections(db: AsyncSession = Depends(get_db)) -> CollectionListOut:
    return await knowledge_service.list_collections(db)


@router.post(
    "/collections/delete",
    response_model=CollectionDeleteOut,
    summary="删除整个合集的已入库分集",
    description="按合集名删除全部已入库条目；对应喂养来源恢复为 ready，可再次入库。",
)
async def delete_collection(
    payload: CollectionDeleteIn, db: AsyncSession = Depends(get_db)
) -> CollectionDeleteOut:
    removed = await knowledge_service.delete_collection(db, payload.title)
    return CollectionDeleteOut(title=payload.title.strip(), removed=removed)


@router.post(
    "/entries/batch-delete",
    response_model=EntryBatchDeleteOut,
    summary="批量删除知识条目",
)
async def batch_delete_entries(
    payload: EntryBatchDeleteIn, db: AsyncSession = Depends(get_db)
) -> EntryBatchDeleteOut:
    if not payload.entry_ids:
        return EntryBatchDeleteOut(removed=0)
    removed = await knowledge_service.delete_entries_batch(db, payload.entry_ids)
    return EntryBatchDeleteOut(removed=removed)


@router.get(
    "/entries",
    response_model=EntryListOut,
    summary="知识条目列表",
)
async def list_entries(
    q: str = Query("", description="标题/摘要关键词"),
    category: str = Query("", description="按分类名过滤"),
    kind: str = Query("", description="类型：book | media | note"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> EntryListOut:
    return await knowledge_service.list_entries(
        db, q=q, category=category, kind=kind, page=page, page_size=page_size
    )


@router.get(
    "/entries/{entry_id}",
    response_model=EntryDetailOut,
    summary="条目详情",
)
async def get_entry(entry_id: int, db: AsyncSession = Depends(get_db)) -> EntryDetailOut:
    return await knowledge_service.get_entry(db, entry_id)


@router.put(
    "/entries/{entry_id}/categories",
    response_model=EntryDetailOut,
    summary="设置条目的人工分类",
    description="仅替换 kind=domain 的关联；自动标签（kind=tag）不会被改动。",
)
async def set_entry_categories(
    entry_id: int,
    payload: EntryCategoriesIn,
    db: AsyncSession = Depends(get_db),
) -> EntryDetailOut:
    return await knowledge_service.set_entry_categories(db, entry_id, payload)


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


@router.post(
    "/annotations/{ann_id}/promote",
    response_model=AnnotationOut,
    summary="确认预笔记为正式笔记",
    description="仅 kind=chat_anchor 的对话预笔记可升级；不会自动混入正式笔记。",
)
async def promote_annotation(
    ann_id: int,
    payload: AnnotationPromoteIn = AnnotationPromoteIn(),
    db: AsyncSession = Depends(get_db),
) -> AnnotationOut:
    return await knowledge_service.promote_annotation(db, ann_id, payload)


@router.post(
    "/annotations/{ann_id}/expand",
    response_model=AnnotationOut,
    summary="补全高亮段落",
    description="把当前高亮向前/后扩成更完整的句子段落，缓解没头没尾。",
)
async def expand_annotation(
    ann_id: int,
    payload: AnnotationExpandIn = AnnotationExpandIn(),
    db: AsyncSession = Depends(get_db),
) -> AnnotationOut:
    return await knowledge_service.expand_annotation(db, ann_id, payload)


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
