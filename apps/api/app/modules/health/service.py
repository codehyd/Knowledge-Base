from sqlalchemy import text

from app.core.database import get_engine
from app.modules.health.schemas import HealthOut

DB_UNAVAILABLE_MESSAGE = (
    "未检测到可用数据库。请到「设置 → 数据库」检查连接；"
    "默认使用本地 SQLite（data/kongku.db），也可配置 Postgres。"
)


class HealthService:
    """健康检查：API 进程与数据库分开探测，无库时仍返回 200。"""

    async def check(self) -> HealthOut:
        database_ok = False
        message = ""
        try:
            async with get_engine().connect() as conn:
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
