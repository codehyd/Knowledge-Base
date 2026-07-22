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


async def _ensure_ai_settings_columns(conn) -> None:
    """一次性兼容迁移：补 ai_settings.provider（勿在请求路径里重复 ALTER）。"""
    await conn.execute(
        text(
            "ALTER TABLE ai_settings "
            "ADD COLUMN IF NOT EXISTS provider VARCHAR(100) DEFAULT 'deepseek'"
        )
    )


async def _ensure_entry_columns(conn) -> None:
    """兼容迁移：条目去重指纹字段。"""
    await conn.execute(
        text(
            "ALTER TABLE entries "
            "ADD COLUMN IF NOT EXISTS title_key VARCHAR(200) DEFAULT ''"
        )
    )
    await conn.execute(
        text(
            "ALTER TABLE entries "
            "ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64) DEFAULT ''"
        )
    )
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_entries_title_key ON entries (title_key)")
    )
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_entries_content_hash ON entries (content_hash)"
        )
    )


async def init_db() -> None:
    # 导入各模块 Model，确保 metadata 注册（新增模块在此加一行）
    from app.core.capabilities import set_vector_enabled
    from app.modules.settings_ai import models as _settings_ai  # noqa: F401
    from app.modules.knowledge import models as _knowledge  # noqa: F401
    from app.modules.sources import models as _sources  # noqa: F401
    from app.modules.chat import models as _chat  # noqa: F401

    vector_ok = False
    # 单独连接尝试启用 pgvector；失败不影响后续建表（开发可用普通 Postgres）
    async with engine.connect() as conn:
        try:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.commit()
            vector_ok = True
        except Exception:
            await conn.rollback()
            vector_ok = False

    set_vector_enabled(vector_ok)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        try:
            await _ensure_ai_settings_columns(conn)
        except Exception:
            # 列已存在或其它兼容问题：不阻塞启动
            pass
        try:
            await _ensure_entry_columns(conn)
        except Exception:
            pass
