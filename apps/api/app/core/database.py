from collections.abc import AsyncGenerator
from typing import Any

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


# 业务必需表：新增模块 Model 后务必同步到此列表与 init_db 的 import
REQUIRED_TABLES: tuple[str, ...] = (
    "ai_settings",
    "entries",
    "categories",
    "entry_categories",
    "entry_annotations",
    "chunks",
    "sources",
    "chat_sessions",
    "chat_messages",
)

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


async def reconnect(url: str, *, initialize: bool = True) -> dict[str, Any] | None:
    """热切换：关掉旧连接，换新 URL；可选执行 init_db。"""
    await dispose_engine()
    configure_engine(url)
    if initialize:
        return await init_db()
    return None


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    if SessionLocal is None:
        init_engine_from_config()
    assert SessionLocal is not None
    async with SessionLocal() as session:
        yield session


def _import_models() -> None:
    """导入各模块 Model，确保 metadata 注册（新增模块在此加一行）。"""
    from app.modules.chat import models as _chat  # noqa: F401
    from app.modules.knowledge import models as _knowledge  # noqa: F401
    from app.modules.settings_ai import models as _settings_ai  # noqa: F401
    from app.modules.sources import models as _sources  # noqa: F401


async def _existing_tables(conn) -> set[str]:
    def _tables(sync_conn) -> set[str]:
        insp = inspect(sync_conn)
        return set(insp.get_table_names())

    return await conn.run_sync(_tables)


async def schema_status() -> dict[str, Any]:
    """探测当前引擎上的表是否齐全（不建表）。"""
    _import_models()
    if engine is None:
        init_engine_from_config()
    assert engine is not None

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
            existing = await _existing_tables(conn)
    except Exception as exc:
        return {
            "connected": False,
            "schema_ready": False,
            "missing_tables": list(REQUIRED_TABLES),
            "existing_tables": [],
            "message": f"无法连接数据库：{exc}",
        }

    missing = [t for t in REQUIRED_TABLES if t not in existing]
    ready = len(missing) == 0
    return {
        "connected": True,
        "schema_ready": ready,
        "missing_tables": missing,
        "existing_tables": sorted(t for t in existing if t in REQUIRED_TABLES),
        "message": (
            "表结构已就绪"
            if ready
            else f"缺少 {len(missing)} 张表，请执行初始化：{', '.join(missing)}"
        ),
    }


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
    await _add_column_if_missing(
        conn, "ai_settings", "provider", "VARCHAR(100) DEFAULT 'deepseek'"
    )
    await _add_column_if_missing(
        conn, "ai_settings", "asr_mode", "VARCHAR(20) DEFAULT 'auto'"
    )
    await _add_column_if_missing(
        conn, "ai_settings", "asr_base_url", "VARCHAR(500) DEFAULT ''"
    )
    await _add_column_if_missing(conn, "ai_settings", "asr_api_key", "TEXT DEFAULT ''")
    await _add_column_if_missing(
        conn, "ai_settings", "asr_model", "VARCHAR(200) DEFAULT ''"
    )
    await _add_column_if_missing(
        conn, "ai_settings", "asr_local_model", "VARCHAR(50) DEFAULT 'base'"
    )


async def _ensure_entry_columns(conn) -> None:
    await _add_column_if_missing(conn, "entries", "title_key", "VARCHAR(200) DEFAULT ''")
    await _add_column_if_missing(conn, "entries", "content_hash", "VARCHAR(64) DEFAULT ''")
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_entries_title_key ON entries (title_key)")
    )
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_entries_content_hash ON entries (content_hash)")
    )


async def _ensure_source_book_columns(conn) -> None:
    await _add_column_if_missing(
        conn, "sources", "provenance", "VARCHAR(40) DEFAULT ''"
    )
    await _add_column_if_missing(
        conn, "sources", "book_kind", "VARCHAR(20) DEFAULT ''"
    )
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_sources_provenance ON sources (provenance)")
    )
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_sources_book_kind ON sources (book_kind)")
    )
    # 存量电子书按扩展名回填（无法还原公版书出处，统一按本地上传规则）
    await conn.execute(
        text(
            """
            UPDATE sources
            SET provenance = 'upload',
                book_kind = CASE
                    WHEN lower(filename) LIKE '%.epub' OR lower(filename) LIKE '%.pdf'
                        THEN 'confirmed'
                    WHEN lower(filename) LIKE '%.txt'
                        THEN 'possible'
                    ELSE 'possible'
                END
            WHERE type = 'ebook'
              AND (book_kind IS NULL OR book_kind = '')
            """
        )
    )


async def _ensure_seed_rows() -> None:
    """保证基础配置行存在（幂等）。"""
    if SessionLocal is None:
        return
    from app.core.config import get_settings
    from app.modules.settings_ai.models import AiSettings
    from app.modules.settings_ai.providers import infer_provider_id

    async with SessionLocal() as db:
        row = await db.get(AiSettings, 1)
        if row is not None:
            return
        env = get_settings()
        db.add(
            AiSettings(
                id=1,
                provider=infer_provider_id(env.llm_base_url) or "deepseek",
                base_url=env.llm_base_url,
                api_key=env.llm_api_key,
                chat_model=env.llm_chat_model,
                embed_model=env.llm_embed_model,
            )
        )
        await db.commit()


async def init_db() -> dict[str, Any]:
    """创建/对齐表结构与轻量列迁移，并写入默认配置行。失败抛出异常。"""
    from app.core.capabilities import set_vector_enabled

    _import_models()

    if engine is None:
        init_engine_from_config()
    assert engine is not None

    before = await schema_status()
    missing_before = list(before.get("missing_tables") or [])

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
        await _ensure_ai_settings_columns(conn)
        await _ensure_entry_columns(conn)
        await _ensure_source_book_columns(conn)

    await _ensure_seed_rows()

    after = await schema_status()
    if not after["schema_ready"]:
        raise RuntimeError(after["message"] or "初始化后表结构仍不完整")

    created = [t for t in missing_before if t not in (after.get("missing_tables") or [])]
    return {
        "ok": True,
        "created_tables": created,
        "schema_ready": True,
        "missing_tables": [],
        "vector_extension": vector_ok,
        "message": (
            "数据库已初始化"
            if created
            else "表结构已对齐（无需新建表）"
        ),
    }


# 模块导入时按配置初始化引擎（允许后续 reconnect 替换）
init_engine_from_config()
