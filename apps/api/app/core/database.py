from collections.abc import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import get_settings


class Base(DeclarativeBase):
    """所有功能模块的 Model 继承此基类，方便统一建表。"""


settings = get_settings()
engine = create_async_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session


async def init_db() -> None:
    # 导入各模块 Model，确保 metadata 注册（新增模块在此加一行）
    from app.modules.settings_ai import models as _settings_ai  # noqa: F401
    from app.modules.knowledge import models as _knowledge  # noqa: F401

    # 单独连接尝试启用 pgvector；失败不影响后续建表（开发可用普通 Postgres）
    async with engine.connect() as conn:
        try:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.commit()
        except Exception:
            await conn.rollback()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
