from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.library.schemas import LibraryOut, LibraryRebuildOut
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
    description="按当前来源重新生成 data/library 下的分类与标题文件夹。",
)
async def rebuild_library(db: AsyncSession = Depends(get_db)) -> LibraryRebuildOut:
    return await library_service.rebuild(db)
