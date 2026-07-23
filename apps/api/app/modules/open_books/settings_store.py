"""公版/开放电子书运行时设置（书源 Key、镜像仓库等）。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from app.core.config import get_settings

RUNTIME_FILENAME = "runtime-feed.json"

DEFAULT_MIRROR_REPO = "xp44mm/hanchuancaolu"
DEFAULT_MIRROR_REF = "master"

MIRROR_PRESETS: list[dict[str, str]] = [
    {
        "id": "hanchuancaolu",
        "name": "汉川草庐（推荐）",
        "repo": "xp44mm/hanchuancaolu",
        "ref": "master",
        "desc": "四大名著、三言两拍、诸子等，经 jsDelivr 加速，国内较稳",
    },
]


def _feed_config_path() -> Path:
    return Path(get_settings().data_dir).expanduser().resolve() / RUNTIME_FILENAME


def _defaults() -> dict[str, Any]:
    return {
        "open_ebook_direct_ingest": False,
        "ctext_api_key": "",
        "mirror_repo": DEFAULT_MIRROR_REPO,
        "mirror_ref": DEFAULT_MIRROR_REF,
    }


def _normalize_repo(repo: str) -> str:
    raw = (repo or "").strip().removeprefix("https://github.com/").removeprefix("http://github.com/")
    raw = raw.strip("/").removesuffix(".git")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", raw):
        raise ValueError("镜像仓库格式应为 owner/repo，例如 xp44mm/hanchuancaolu")
    return raw


def load_feed_settings() -> dict[str, Any]:
    defaults = _defaults()
    path = _feed_config_path()
    if not path.is_file():
        return dict(defaults)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return dict(defaults)
    if not isinstance(data, dict):
        return dict(defaults)

    repo = str(data.get("mirror_repo") or defaults["mirror_repo"]).strip()
    ref = str(data.get("mirror_ref") or defaults["mirror_ref"]).strip() or DEFAULT_MIRROR_REF
    try:
        repo = _normalize_repo(repo)
    except ValueError:
        repo = DEFAULT_MIRROR_REPO

    return {
        "open_ebook_direct_ingest": bool(
            data.get("open_ebook_direct_ingest", defaults["open_ebook_direct_ingest"])
        ),
        "ctext_api_key": str(data.get("ctext_api_key") or "").strip(),
        "mirror_repo": repo,
        "mirror_ref": ref,
    }


def save_feed_settings(
    *,
    open_ebook_direct_ingest: bool | None = None,
    ctext_api_key: str | None = None,
    mirror_repo: str | None = None,
    mirror_ref: str | None = None,
) -> dict[str, Any]:
    current = load_feed_settings()
    if open_ebook_direct_ingest is not None:
        current["open_ebook_direct_ingest"] = bool(open_ebook_direct_ingest)
    if ctext_api_key is not None:
        current["ctext_api_key"] = str(ctext_api_key).strip()
    if mirror_repo is not None:
        current["mirror_repo"] = _normalize_repo(mirror_repo)
    if mirror_ref is not None:
        ref = str(mirror_ref).strip() or DEFAULT_MIRROR_REF
        current["mirror_ref"] = ref

    path = _feed_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 仓库变更后清目录缓存
    if mirror_repo is not None or mirror_ref is not None:
        from app.modules.open_books.providers.mirror_cdn import invalidate_dir_cache

        invalidate_dir_cache()

    return current


def resolve_ctext_api_key() -> str:
    runtime = (load_feed_settings().get("ctext_api_key") or "").strip()
    if runtime:
        return runtime
    return (get_settings().ctext_api_key or "").strip()


def resolve_mirror_repo() -> tuple[str, str]:
    cfg = load_feed_settings()
    repo = str(cfg.get("mirror_repo") or DEFAULT_MIRROR_REPO).strip()
    ref = str(cfg.get("mirror_ref") or DEFAULT_MIRROR_REF).strip() or DEFAULT_MIRROR_REF
    try:
        repo = _normalize_repo(repo)
    except ValueError:
        repo = DEFAULT_MIRROR_REPO
    return repo, ref
