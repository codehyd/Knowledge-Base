"""业务库连接配置（落在 DB 外，避免鸡生蛋问题）。

优先级：data/runtime-db.json → 环境变量 DATABASE_URL → 默认 SQLite。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlparse, urlunparse

from app.core.config import get_settings

DbMode = Literal["sqlite", "postgres"]

DEFAULT_SQLITE_REL = "kongku.db"
RUNTIME_FILENAME = "runtime-db.json"


def data_dir() -> Path:
    return Path(get_settings().data_dir).expanduser().resolve()


def runtime_config_path() -> Path:
    return data_dir() / RUNTIME_FILENAME


def default_sqlite_path() -> Path:
    return data_dir() / DEFAULT_SQLITE_REL


def normalize_postgres_url(url: str) -> str:
    """允许用户粘贴 postgresql://，统一成 asyncpg 驱动。"""
    raw = (url or "").strip()
    if not raw:
        return ""
    if raw.startswith("postgresql+asyncpg://"):
        return raw
    if raw.startswith("postgres://"):
        return "postgresql+asyncpg://" + raw[len("postgres://") :]
    if raw.startswith("postgresql://"):
        return "postgresql+asyncpg://" + raw[len("postgresql://") :]
    return raw


def sqlite_url_for_path(path: str | Path) -> str:
    p = Path(path).expanduser()
    if not p.is_absolute():
        # 相对路径相对仓库/进程工作目录；若落在 data_dir 下也可直接写相对
        p = p.resolve()
    else:
        p = p.resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    # SQLAlchemy 需要至少三个斜杠：sqlite+aiosqlite:///abs/path
    return f"sqlite+aiosqlite:///{p.as_posix()}"


def load_runtime_config() -> dict[str, Any] | None:
    path = runtime_config_path()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def save_runtime_config(*, mode: DbMode, sqlite_path: str, postgres_url: str) -> None:
    data_dir().mkdir(parents=True, exist_ok=True)
    payload = {
        "mode": mode,
        "sqlite_path": sqlite_path,
        "postgres_url": postgres_url,
    }
    runtime_config_path().write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def url_from_runtime(cfg: dict[str, Any]) -> str:
    mode = str(cfg.get("mode") or "sqlite").strip().lower()
    if mode == "postgres":
        url = normalize_postgres_url(str(cfg.get("postgres_url") or ""))
        if not url:
            raise ValueError("Postgres 模式需要填写连接地址")
        return url
    path = str(cfg.get("sqlite_path") or "").strip() or str(default_sqlite_path())
    return sqlite_url_for_path(path)


def resolve_database_url() -> str:
    """解析当前应使用的数据库 URL。"""
    cfg = load_runtime_config()
    if cfg is not None:
        try:
            return url_from_runtime(cfg)
        except ValueError:
            pass

    env_url = (get_settings().database_url or "").strip()
    if env_url:
        if env_url.startswith("sqlite"):
            return env_url
        return normalize_postgres_url(env_url)

    return sqlite_url_for_path(default_sqlite_path())


def detect_mode_from_url(url: str) -> DbMode:
    return "sqlite" if url.startswith("sqlite") else "postgres"


def mask_database_url(url: str) -> str:
    """脱敏连接串中的密码。"""
    if not url or url.startswith("sqlite"):
        return url
    try:
        parsed = urlparse(url)
        if not parsed.password:
            return url
        user = unquote(parsed.username or "")
        host = parsed.hostname or ""
        port = f":{parsed.port}" if parsed.port else ""
        netloc = f"{user}:***@{host}{port}"
        return urlunparse(
            (parsed.scheme, netloc, parsed.path, parsed.params, parsed.query, parsed.fragment)
        )
    except Exception:
        return re.sub(r":([^:@/]+)@", ":***@", url)


def parse_postgres_parts(url: str) -> dict[str, str]:
    """从连接串解析主机/端口/库名/用户（不含密码明文返回）。"""
    raw = normalize_postgres_url(url)
    if not raw:
        return {
            "host": "",
            "port": "5432",
            "database": "",
            "username": "",
        }
    parsed = urlparse(raw)
    db = (parsed.path or "").lstrip("/")
    return {
        "host": parsed.hostname or "",
        "port": str(parsed.port or 5432),
        "database": db,
        "username": unquote(parsed.username or ""),
    }


def build_postgres_url(
    *,
    host: str,
    port: str | int | None,
    database: str,
    username: str,
    password: str,
) -> str:
    from urllib.parse import quote_plus

    h = (host or "").strip()
    db = (database or "").strip().lstrip("/")
    user = (username or "").strip()
    pwd = password or ""
    if not h or not db or not user:
        raise ValueError("请填写主机、数据库名和用户名")
    if not pwd:
        raise ValueError("请填写密码")
    p = str(port or "5432").strip() or "5432"
    return (
        f"postgresql+asyncpg://{quote_plus(user)}:{quote_plus(pwd)}"
        f"@{h}:{p}/{db}"
    )


def extract_postgres_password(url: str) -> str:
    raw = normalize_postgres_url(url)
    if not raw:
        return ""
    parsed = urlparse(raw)
    return unquote(parsed.password) if parsed.password else ""


def sqlite_path_from_url(url: str) -> str:
    if not url.startswith("sqlite"):
        return str(default_sqlite_path())
    # sqlite+aiosqlite:///path
    prefix = "sqlite+aiosqlite:///"
    if url.startswith(prefix):
        return url[len(prefix) :]
    if url.startswith("sqlite:///"):
        return url[len("sqlite:///") :]
    return str(default_sqlite_path())
