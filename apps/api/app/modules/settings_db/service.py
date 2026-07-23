"""数据库连接设置：读写 runtime-db.json，并支持热切换与显式初始化。"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.core import database as db_mod
from app.core.runtime_db import (
    build_postgres_url,
    default_sqlite_path,
    detect_mode_from_url,
    extract_postgres_password,
    load_runtime_config,
    mask_database_url,
    normalize_postgres_url,
    parse_postgres_parts,
    resolve_database_url,
    resolve_sqlite_path,
    save_runtime_config,
    sqlite_path_from_url,
    sqlite_url_for_path,
)
from app.modules.settings_db.schemas import (
    DbInitOut,
    DbSettingsOut,
    DbSettingsUpdate,
    DbTestOut,
    DbTestRequest,
)


class SettingsDbService:
    async def _probe(self, url: str) -> tuple[bool, str]:
        engine = None
        try:
            kwargs: dict = {}
            if url.startswith("sqlite"):
                from sqlalchemy.pool import NullPool

                kwargs["poolclass"] = NullPool
            engine = create_async_engine(url, **kwargs)
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            return True, "连接成功"
        except Exception as exc:
            return False, f"连接失败：{exc}"
        finally:
            if engine is not None:
                await engine.dispose()

    def _resolve_postgres_url(
        self,
        *,
        postgres_url: str | None,
        host: str | None,
        port: str | None,
        database: str | None,
        username: str | None,
        password: str | None,
        previous_postgres: str = "",
    ) -> str:
        if (
            host is not None
            or port is not None
            or database is not None
            or username is not None
            or password is not None
        ):
            prev_parts = parse_postgres_parts(previous_postgres) if previous_postgres else {}
            prev_pwd = extract_postgres_password(previous_postgres) if previous_postgres else ""
            h = (host if host is not None else "").strip() or prev_parts.get("host", "")
            p = (port if port is not None else "").strip() or prev_parts.get("port", "5432")
            db = (database if database is not None else "").strip() or prev_parts.get(
                "database", ""
            )
            user = (username if username is not None else "").strip() or prev_parts.get(
                "username", ""
            )
            pwd = (password or "").strip() or prev_pwd
            return build_postgres_url(
                host=h, port=p, database=db, username=user, password=pwd
            )

        raw = (postgres_url or "").strip() or previous_postgres
        url = normalize_postgres_url(raw)
        if not url:
            raise ValueError("请填写主机、数据库名、用户名和密码")
        return url

    def _build_url(
        self,
        *,
        mode: str,
        sqlite_path: str,
        postgres_url: str | None = None,
        host: str | None = None,
        port: str | None = None,
        database: str | None = None,
        username: str | None = None,
        password: str | None = None,
        previous_postgres: str = "",
    ) -> str:
        if mode == "postgres":
            return self._resolve_postgres_url(
                postgres_url=postgres_url,
                host=host,
                port=port,
                database=database,
                username=username,
                password=password,
                previous_postgres=previous_postgres,
            )
        path = (sqlite_path or "").strip() or str(default_sqlite_path())
        return sqlite_url_for_path(path)

    def current_snapshot(self) -> dict:
        cfg = load_runtime_config()
        effective = resolve_database_url()
        mode = detect_mode_from_url(effective)
        sqlite_path = str(default_sqlite_path())
        postgres_url = ""
        if cfg:
            mode = str(cfg.get("mode") or mode).lower()  # type: ignore[assignment]
            if mode not in ("sqlite", "postgres"):
                mode = detect_mode_from_url(effective)
            raw_sqlite = str(cfg.get("sqlite_path") or sqlite_path)
            sqlite_path = str(resolve_sqlite_path(raw_sqlite))
            postgres_url = str(cfg.get("postgres_url") or "")
        else:
            if mode == "sqlite":
                sqlite_path = sqlite_path_from_url(effective)
            else:
                postgres_url = effective

        return {
            "mode": mode,
            "sqlite_path": sqlite_path,
            "postgres_url": postgres_url,
            "effective": effective,
        }

    async def _to_out(self, snap: dict, *, connected: bool, message: str = "") -> DbSettingsOut:
        schema = await db_mod.schema_status()
        if not connected and schema.get("connected"):
            connected = True
        if connected and not message and not schema.get("schema_ready"):
            message = str(schema.get("message") or "")

        pg = snap["postgres_url"]
        parts = (
            parse_postgres_parts(pg)
            if pg
            else {
                "host": "",
                "port": "5432",
                "database": "",
                "username": "",
            }
        )
        return DbSettingsOut(
            mode=snap["mode"],  # type: ignore[arg-type]
            sqlite_path=snap["sqlite_path"],
            postgres_url_masked=mask_database_url(pg) if pg else "",
            postgres_configured=bool(pg),
            postgres_host=parts["host"],
            postgres_port=parts["port"] or "5432",
            postgres_database=parts["database"],
            postgres_username=parts["username"],
            effective_url_masked=mask_database_url(snap["effective"]),
            connected=connected,
            message=message,
            schema_ready=bool(schema.get("schema_ready")),
            missing_tables=list(schema.get("missing_tables") or []),
            schema_message=str(schema.get("message") or ""),
        )

    async def get(self) -> DbSettingsOut:
        snap = self.current_snapshot()
        connected = False
        message = ""
        try:
            async with db_mod.get_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))
            connected = True
        except Exception as exc:
            connected = False
            message = str(exc)
        return await self._to_out(snap, connected=connected, message=message)

    async def test(self, payload: DbTestRequest) -> DbTestOut:
        snap = self.current_snapshot()
        try:
            url = self._build_url(
                mode=payload.mode,
                sqlite_path=payload.sqlite_path,
                postgres_url=payload.postgres_url,
                host=payload.postgres_host,
                port=payload.postgres_port,
                database=payload.postgres_database,
                username=payload.postgres_username,
                password=payload.postgres_password,
                previous_postgres=snap["postgres_url"],
            )
        except ValueError as exc:
            return DbTestOut(ok=False, message=str(exc))
        ok, msg = await self._probe(url)
        return DbTestOut(ok=ok, message=msg)

    async def update(self, payload: DbSettingsUpdate) -> DbSettingsOut:
        snap = self.current_snapshot()
        previous_pg = snap["postgres_url"]
        new_pg = previous_pg

        if payload.mode == "postgres":
            new_pg = self._resolve_postgres_url(
                postgres_url=payload.postgres_url,
                host=payload.postgres_host,
                port=payload.postgres_port,
                database=payload.postgres_database,
                username=payload.postgres_username,
                password=payload.postgres_password,
                previous_postgres=previous_pg,
            )
        elif payload.postgres_url is not None and payload.postgres_url.strip():
            new_pg = normalize_postgres_url(payload.postgres_url.strip())

        sqlite_path = str(default_sqlite_path())
        url = self._build_url(
            mode=payload.mode,
            sqlite_path=sqlite_path,
            postgres_url=new_pg if payload.mode == "postgres" else None,
            previous_postgres=new_pg,
        )

        ok, msg = await self._probe(url)
        if not ok:
            raise ValueError(msg)

        save_runtime_config(
            mode=payload.mode,
            sqlite_path=sqlite_path,
            postgres_url=new_pg,
        )

        # SQLite：切换即自动建表；Postgres：仅切换连接，表结构由用户点击初始化
        await db_mod.reconnect(url, initialize=(payload.mode == "sqlite"))
        return await self.get()

    async def initialize_schema(self) -> DbInitOut:
        """对当前已连接库执行建表 / 对齐（客户点击触发，尤其 Postgres）。"""
        try:
            async with db_mod.get_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))
        except Exception as exc:
            raise ValueError(f"当前数据库未连接，无法初始化：{exc}") from exc

        result = await db_mod.init_db()
        return DbInitOut(
            ok=True,
            message=str(result.get("message") or "初始化完成"),
            created_tables=list(result.get("created_tables") or []),
            schema_ready=bool(result.get("schema_ready")),
            missing_tables=list(result.get("missing_tables") or []),
            vector_extension=bool(result.get("vector_extension")),
        )


settings_db_service = SettingsDbService()
