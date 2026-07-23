from sqlalchemy import text

from app.core.database import get_engine, schema_status
from app.modules.health.schemas import HealthOut

DB_UNAVAILABLE_MESSAGE = (
    "未检测到可用数据库。请到「设置 → 数据库」检查连接；"
    "默认使用本地 SQLite（data/kongku.db），也可配置 Postgres。"
)

DB_SCHEMA_MESSAGE = (
    "数据库已连接，但表结构未就绪。请到「设置 → 数据库」点击「初始化表结构」。"
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
            status = await schema_status()
            if not status.get("schema_ready"):
                message = DB_SCHEMA_MESSAGE
                # 仍算「库可连」，但附带 schema 提示；前端可用 database_message 展示
        except Exception:
            database_ok = False
            message = DB_UNAVAILABLE_MESSAGE

        return HealthOut(
            ok=True,
            database=database_ok,
            database_message=message,
        )


health_service = HealthService()
