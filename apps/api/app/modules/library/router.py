from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.library.schemas import LibraryDeleteOut, LibraryOut, LibraryRebuildOut
from app.modules.library.service import library_service

router = APIRouter(prefix="/library", tags=["我的资源"])


@router.get(
    "",
    response_model=LibraryOut,
    summary="列出本地资源库",
    description="按「书籍 / 视频 / 网页 / 笔记」分类，每项以标题为文件夹，内含正文、音轨等。",
)
async def list_library(db: AsyncSession = Depends(get_db)) -> LibraryOut:
    return await library_service.list_library(db)


@router.post(
    "/rebuild",
    response_model=LibraryRebuildOut,
    summary="重建资源库文件夹",
    description=(
        "按当前喂养来源重新生成 data/library。"
        "只删资源文件夹会被还原；要永久删除请用 DELETE /api/library/items/{source_id}。"
    ),
)
async def rebuild_library(db: AsyncSession = Depends(get_db)) -> LibraryRebuildOut:
    return await library_service.rebuild(db)


@router.delete(
    "/items/{source_id}",
    response_model=LibraryDeleteOut,
    summary="删除一项资源（永久）",
    description="删除喂养来源、已入库知识条目、uploads 与 library 镜像；重建后不会再出现。",
)
async def delete_library_item(
    source_id: int,
    db: AsyncSession = Depends(get_db),
) -> LibraryDeleteOut:
    return await library_service.delete_item(db, source_id)
