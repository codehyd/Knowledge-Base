"""vault 路径安全与根目录。"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import HTTPException

from app.core.config import get_settings

_INVALID = re.compile(r'[<>:"|?*\x00-\x1f]')
_REPO_ROOT = Path(__file__).resolve().parents[5]


def data_root() -> Path:
    settings = get_settings()
    root = Path(settings.data_dir)
    if not root.is_absolute():
        root = _REPO_ROOT / root
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def vault_root() -> Path:
    root = data_root() / "vault"
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def safe_segment(name: str) -> str:
    cleaned = _INVALID.sub("", (name or "").strip()).strip(" .")
    cleaned = cleaned.replace("/", "").replace("\\", "")
    if not cleaned or cleaned in {".", ".."}:
        raise HTTPException(status_code=400, detail="非法名称")
    if len(cleaned) > 120:
        cleaned = cleaned[:120].rstrip(" .")
    return cleaned


def normalize_rel(path: str) -> str:
    raw = (path or "").replace("\\", "/").strip().lstrip("/")
    if not raw or raw == ".":
        return ""
    parts: list[str] = []
    for part in raw.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            raise HTTPException(status_code=400, detail="非法路径")
        parts.append(safe_segment(part))
    return "/".join(parts)


def resolve_in_vault(rel: str) -> Path:
    root = vault_root()
    norm = normalize_rel(rel)
    target = (root / norm).resolve() if norm else root
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="路径越界") from exc
    return target


def to_vault_rel(path: Path) -> str:
    root = vault_root()
    rel = path.resolve().relative_to(root)
    return str(rel).replace("\\", "/")


def note_filename(title: str) -> str:
    base = safe_segment(title or "未命名笔记")
    if base.lower().endswith(".md"):
        return base
    return f"{base}.md"
