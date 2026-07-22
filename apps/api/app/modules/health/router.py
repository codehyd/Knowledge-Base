from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.health.schemas import HealthOut
from app.modules.health.service import health_service

router = APIRouter(tags=["健康检查"])


@router.get(
    "/health",
    response_model=HealthOut,
    summary="健康检查",
    description="探测 API 进程与数据库是否可用。",
)
async def health(db: AsyncSession = Depends(get_db)) -> HealthOut:
    return await health_service.check(db)
