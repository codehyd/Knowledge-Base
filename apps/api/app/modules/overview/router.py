from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.overview.schemas import OverviewOut
from app.modules.overview.service import overview_service

router = APIRouter(prefix="/stats", tags=["overview"])


@router.get("/overview", response_model=OverviewOut)
async def overview(db: AsyncSession = Depends(get_db)) -> OverviewOut:
    return await overview_service.get(db)
