from collections.abc import AsyncGenerator

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.core.runtime_db import resolve_database_url


class Base(DeclarativeBase):
    """所有功能模块的 Model 继承此基类，方便统一建表。"""


engine: AsyncEngine | None = None
SessionLocal: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    if engine is None:
        raise RuntimeError("数据库引擎尚未初始化")
    return engine


def configure_engine(url: str) -> AsyncEngine:
    """创建（或替换引用前）引擎；不负责 dispose 旧引擎。"""
    global engine, SessionLocal
    kwargs: dict = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        # SQLite 文件库：避免连接池跨线程问题
        from sqlalchemy.pool import NullPool

        kwargs["poolclass"] = NullPool
    engine = create_async_engine(url, **kwargs)
    SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return engine


def init_engine_from_config() -> AsyncEngine:
    return configure_engine(resolve_database_url())


async def dispose_engine() -> None:
    global engine, SessionLocal
    if engine is not None:
        await engine.dispose()
    engine = None
    SessionLocal = None


async def reconnect(url: str) -> None:
    """热切换：关掉旧连接，换新 URL，并 init_db。"""
    await dispose_engine()
    configure_engine(url)
    await init_db()


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    if SessionLocal is None:
        init_engine_from_config()
    assert SessionLocal is not None
    async with SessionLocal() as session:
        yield session


async def _table_columns(conn, table: str) -> set[str]:
    def _cols(sync_conn) -> set[str]:
        insp = inspect(sync_conn)
        if not insp.has_table(table):
            return set()
        return {c["name"] for c in insp.get_columns(table)}

    return await conn.run_sync(_cols)


async def _add_column_if_missing(conn, table: str, column: str, ddl_type: str) -> None:
    cols = await _table_columns(conn, table)
    if column in cols:
        return
    await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"))


async def _ensure_ai_settings_columns(conn) -> None:
    """一次性兼容迁移：补 ai_settings.provider。"""
    await _add_column_if_missing(
        conn, "ai_settings", "provider", "VARCHAR(100) DEFAULT 'deepseek'"
    )


async def _ensure_entry_columns(conn) -> None:
    """兼容迁移：条目去重指纹字段。"""
    await _add_column_if_missing(conn, "entries", "title_key", "VARCHAR(200) DEFAULT ''")
    await _add_column_if_missing(conn, "entries", "content_hash", "VARCHAR(64) DEFAULT ''")
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_entries_title_key ON entries (title_key)")
    )
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_entries_content_hash ON entries (content_hash)")
    )


async def init_db() -> None:
    # 导入各模块 Model，确保 metadata 注册（新增模块在此加一行）
    from app.core.capabilities import set_vector_enabled
    from app.modules.settings_ai import models as _settings_ai  # noqa: F401
    from app.modules.knowledge import models as _knowledge  # noqa: F401
    from app.modules.sources import models as _sources  # noqa: F401
    from app.modules.chat import models as _chat  # noqa: F401

    if engine is None:
        init_engine_from_config()
    assert engine is not None

    vector_ok = False
    dialect = engine.dialect.name
    if dialect.startswith("postgres"):
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
            pass
        try:
            await _ensure_entry_columns(conn)
        except Exception:
            pass


# 模块导入时按配置初始化（允许后续 reconnect 替换）
init_engine_from_config()
