"""vault 路径安全与根目录。

手写笔记与喂养资源同属「我的资源」根目录：
  data/library/笔记库/  —— 可编辑多级 .md（原 data/vault）
  data/library/书籍|视频|…/ —— 喂养镜像
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from fastapi import HTTPException

from app.core.config import get_settings

_INVALID = re.compile(r'[<>:"|?*\x00-\x1f]')
_REPO_ROOT = Path(__file__).resolve().parents[5]
_LOG = logging.getLogger(__name__)

# 资源根下的笔记分类文件夹名（与 library list 的「笔记库」标签一致）
VAULT_CATEGORY_DIR = "笔记库"
_migrated = False


def data_root() -> Path:
    settings = get_settings()
    root = Path(settings.data_dir)
    if not root.is_absolute():
        root = _REPO_ROOT / root
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _migrate_legacy_vault(new_root: Path) -> None:
    """一次性把旧 data/vault 迁到 data/library/笔记库。"""
    global _migrated
    if _migrated:
        return
    _migrated = True
    legacy = data_root() / "vault"
    if not legacy.is_dir():
        return
    new_root.mkdir(parents=True, exist_ok=True)
    moved = 0
    for child in list(legacy.iterdir()):
        if child.name.startswith("."):
            continue
        dest = new_root / child.name
        if dest.exists():
            _LOG.warning("迁移跳过（目标已存在）: %s", child.name)
            continue
        try:
            shutil.move(str(child), str(dest))
            moved += 1
        except OSError as exc:
            _LOG.warning("迁移失败 %s: %s", child, exc)
    try:
        leftovers = [p for p in legacy.iterdir() if not p.name.startswith(".")]
        if not leftovers:
            shutil.rmtree(legacy, ignore_errors=True)
    except OSError:
        pass
    if moved:
        _LOG.info("已将 %s 项从 data/vault 迁移到 library/%s", moved, VAULT_CATEGORY_DIR)


def vault_root() -> Path:
    root = data_root() / "library" / VAULT_CATEGORY_DIR
    _migrate_legacy_vault(root)
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def vault_rel_prefix() -> str:
    """相对 data_root 的笔记库前缀，如 library/笔记库。"""
    return f"library/{VAULT_CATEGORY_DIR}"


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
