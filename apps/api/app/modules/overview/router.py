from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.overview.schemas import OverviewOut
from app.modules.overview.service import overview_service

router = APIRouter(prefix="/stats", tags=["概览统计"])


@router.get(
    "/overview",
    response_model=OverviewOut,
    summary="首页概览",
    description="返回条目数量、是否空库、模型 Key 是否已配置。",
)
async def overview(db: AsyncSession = Depends(get_db)) -> OverviewOut:
    return await overview_service.get(db)
