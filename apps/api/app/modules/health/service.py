from sqlalchemy import text

from app.core.database import engine
from app.modules.health.schemas import HealthOut

DB_UNAVAILABLE_MESSAGE = (
    "未检测到数据库服务。请先在本机启动 Postgres（开发可用 Docker），"
    "并确认 DATABASE_URL 配置正确。"
)


class HealthService:
    """健康检查：API 进程与数据库分开探测，无库时仍返回 200。"""

    async def check(self) -> HealthOut:
        database_ok = False
        message = ""
        try:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            database_ok = True
        except Exception:
            database_ok = False
            message = DB_UNAVAILABLE_MESSAGE

        return HealthOut(
            ok=True,
            database=database_ok,
            database_message=message,
        )


health_service = HealthService()
