from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.knowledge.models import Entry
from app.modules.overview.schemas import OverviewOut
from app.modules.settings_ai.service import settings_ai_service


class OverviewService:
    async def get(self, db: AsyncSession) -> OverviewOut:
        result = await db.execute(select(func.count()).select_from(Entry))
        entries = int(result.scalar_one())
        key_configured = await settings_ai_service.is_configured(db)
        return OverviewOut(
            entries=entries,
            key_configured=key_configured,
            empty_library=entries == 0,
        )


overview_service = OverviewService()
