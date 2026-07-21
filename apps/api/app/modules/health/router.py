from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.health.schemas import HealthOut
from app.modules.health.service import health_service

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthOut)
async def health(db: AsyncSession = Depends(get_db)) -> HealthOut:
    return await health_service.check(db)
