from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from app.modules.health.schemas import HealthOut


class HealthService:
    """健康检查：Controller 只调这里，方便以后加依赖探测。"""

    async def check(self, db: AsyncSession | None = None) -> HealthOut:
        if db is not None:
            await db.execute(text("SELECT 1"))
        return HealthOut(ok=True)


health_service = HealthService()
