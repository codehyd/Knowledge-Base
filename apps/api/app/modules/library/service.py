"""把 uploads/{id}/ 同步成可读的 library/{分类}/{标题}/。"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from fastapi import HTTPException

from app.modules.knowledge.models import Entry
from app.modules.library.schemas import (
    LibraryCategoryOut,
    LibraryDeleteOut,
    LibraryFileOut,
    LibraryItemOut,
    LibraryOut,
    LibraryRebuildOut,
)
from app.modules.sources.models import Source

META_NAME = ".kongku-source.json"

CATEGORY_MAP: dict[str, tuple[str, str]] = {
    "ebook": ("books", "书籍"),
    "video_url": ("videos", "视频"),
    "video_file": ("videos", "视频"),
    "url": ("web", "网页"),
    "note": ("notes", "笔记"),
}

FRIENDLY_NAMES: dict[str, str] = {
    "extracted.txt": "正文.txt",
    "cues.json": "时间轴.json",
    "source.url": "来源.url",
    "share_raw.txt": "分享口令.txt",
}

_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WS = re.compile(r"\s+")


def _data_root() -> Path:
    # 与 vault.paths.data_root 对齐：相对 data_dir 相对仓库根解析，不依赖进程 cwd
    from app.modules.vault.paths import data_root

    return data_root()


def library_root() -> Path:
    root = _data_root() / "library"
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def category_for_type(source_type: str) -> tuple[str, str]:
    return CATEGORY_MAP.get(source_type or "", ("other", "其它"))


def safe_folder_name(title: str, source_id: int) -> str:
    raw = (title or "").strip() or f"未命名-{source_id}"
    cleaned = _INVALID.sub("", raw)
    cleaned = _WS.sub(" ", cleaned).strip(" .")
    if not cleaned:
        cleaned = f"未命名-{source_id}"
    # macOS/Windows 文件名长度留余量
    if len(cleaned) > 80:
        cleaned = cleaned[:80].rstrip(" .")
    return cleaned


def _file_kind(name: str) -> str:
    lower = name.lower()
    if lower in {"正文.txt", "extracted.txt", "分享口令.txt"}:
        return "text"
    if lower.startswith("音轨.") or lower.startswith("media."):
        return "audio"
    if lower in {"时间轴.json", "cues.json"}:
        return "cues"
    if lower.startswith("原件.") or lower.startswith("original."):
        return "original"
    if lower.startswith("."):
        return "meta"
    return "other"


def _link_or_copy(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        dest.unlink()
    try:
        dest.hardlink_to(src)
    except OSError:
        try:
            dest.symlink_to(src)
        except OSError:
            shutil.copy2(src, dest)


def _write_meta(folder: Path, source_id: int, title: str, source_type: str) -> None:
    meta = {
        "source_id": source_id,
        "title": title,
        "type": source_type,
    }
    (folder / META_NAME).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _find_existing_folder(source_id: int) -> Path | None:
    from app.modules.vault.paths import VAULT_CATEGORY_DIR

    root = library_root()
    if not root.is_dir():
        return None
    for meta in root.rglob(META_NAME):
        # 跳过手写笔记树，避免与喂养镜像混淆
        try:
            meta.relative_to(root / VAULT_CATEGORY_DIR)
            continue
        except ValueError:
            pass
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if int(data.get("source_id") or 0) == source_id:
            return meta.parent
    return None


def _collect_upload_files(upload: Path) -> list[tuple[Path, str]]:
    """返回 (源路径, 友好文件名)。"""
    out: list[tuple[Path, str]] = []
    if not upload.is_dir():
        return out

    has_media = False
    for path in sorted(upload.iterdir()):
        if not path.is_file():
            continue
        name = path.name
        if name.startswith("."):
            continue
        if name in FRIENDLY_NAMES:
            out.append((path, FRIENDLY_NAMES[name]))
            continue
        if name.startswith("media."):
            out.append((path, f"音轨{path.suffix or ''}"))
            has_media = True
            continue
        if name.startswith("original."):
            out.append((path, f"原件{path.suffix or ''}"))
            continue
        # 其它零散文件也带过去，便于排查
        out.append((path, name))

    # 旧结构：audio/audio.mp4（仅当没有顶层 media.* 时）
    if not has_media:
        audio_dir = upload / "audio"
        if audio_dir.is_dir():
            for path in sorted(audio_dir.iterdir()):
                if path.is_file() and not path.name.startswith("."):
                    out.append((path, f"音轨{path.suffix or ''}"))

    return out


def remove_source_from_library(source_id: int) -> bool:
    folder = _find_existing_folder(source_id)
    if not folder or not folder.exists():
        return False
    shutil.rmtree(folder, ignore_errors=True)
    # 清理空分类目录
    parent = folder.parent
    try:
        if parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
    except OSError:
        pass
    return True


def sync_source_files(
    *,
    source_id: int,
    source_type: str,
    title: str,
) -> Path | None:
    """把 uploads/{id} 同步到 library/{分类}/{标题}/。无源文件时返回 None。"""
    upload = _data_root() / "uploads" / str(source_id)
    files = _collect_upload_files(upload)
    if not files:
        remove_source_from_library(source_id)
        return None

    cat_label = category_for_type(source_type)[1]
    display_title = (title or "").strip() or f"未命名-{source_id}"
    folder_name = safe_folder_name(display_title, source_id)

    cat_dir = library_root() / cat_label
    cat_dir.mkdir(parents=True, exist_ok=True)
    dest = cat_dir / folder_name

    existing = _find_existing_folder(source_id)
    if existing and existing.resolve() != dest.resolve():
        shutil.rmtree(existing, ignore_errors=True)

    # 同名但属于别的来源：加 id 后缀
    if dest.exists():
        meta_path = dest / META_NAME
        other_id = None
        if meta_path.is_file():
            try:
                other_id = int(json.loads(meta_path.read_text(encoding="utf-8")).get("source_id") or 0)
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                other_id = None
        if other_id not in (None, 0, source_id):
            dest = cat_dir / f"{folder_name} ({source_id})"

    dest.mkdir(parents=True, exist_ok=True)

    # 先清掉旧友好文件（保留目录）
    keep = {META_NAME}
    wanted = {name for _, name in files}
    for child in list(dest.iterdir()):
        if child.name in keep:
            continue
        if child.is_file() and child.name not in wanted:
            child.unlink(missing_ok=True)

    for src, friendly in files:
        _link_or_copy(src, dest / friendly)

    _write_meta(dest, source_id, display_title, source_type)
    return dest


class LibraryService:
    async def _title_for(self, db: AsyncSession, row: Source) -> str:
        result = await db.execute(
            select(Entry.title).where(Entry.source_id == row.id).limit(1)
        )
        entry_title = result.scalar_one_or_none()
        if entry_title and str(entry_title).strip():
            return str(entry_title).strip()
        for candidate in (row.title, row.filename):
            if candidate and str(candidate).strip():
                return str(candidate).strip()
        return f"来源 #{row.id}"

    async def sync_source(self, db: AsyncSession, source_id: int) -> Path | None:
        result = await db.execute(select(Source).where(Source.id == source_id))
        row = result.scalar_one_or_none()
        if not row:
            remove_source_from_library(source_id)
            return None
        # 笔记库 vault 笔记不镜像到 library/笔记/ 扁平目录
        if (getattr(row, "vault_path", None) or "").strip():
            remove_source_from_library(source_id)
            return None
        title = await self._title_for(db, row)
        return sync_source_files(
            source_id=row.id,
            source_type=row.type or "",
            title=title,
        )

    async def delete_item(self, db: AsyncSession, source_id: int) -> LibraryDeleteOut:
        """真正删除资源：喂养来源 + 已入库条目 + uploads + library 镜像。

        注意：只删 data/library 下的文件夹不会生效——重建会按来源再生成。
        """
        row = await db.get(Source, source_id)
        if not row:
            raise HTTPException(status_code=404, detail="资源不存在或已删除")

        # 延迟导入，避免与 sources.service 循环依赖
        from app.modules.sources.service import sources_service

        entries = await db.execute(select(Entry).where(Entry.source_id == source_id))
        for entry in entries.scalars().all():
            await sources_service._remove_entry_tree(db, entry)

        sid = int(row.id)
        vault_rel = (getattr(row, "vault_path", None) or "").strip()
        await db.delete(row)
        await db.commit()

        upload = _data_root() / "uploads" / str(sid)
        if upload.exists():
            shutil.rmtree(upload, ignore_errors=True)
        if vault_rel:
            # 仅当该来源本身是笔记库笔记时才删 vault 文件，避免误解析书籍路径
            if (row.type or "") == "note":
                try:
                    from app.modules.vault.paths import resolve_in_vault
                    from app.modules.vault.service import _lake_source_path

                    vpath = resolve_in_vault(vault_rel)
                    if vpath.is_file():
                        vpath.unlink(missing_ok=True)
                    _lake_source_path(vpath).unlink(missing_ok=True)
                except Exception:
                    pass
        remove_source_from_library(sid)

        return LibraryDeleteOut(
            ok=True,
            source_id=sid,
            message="已删除来源、知识条目与资源目录；重建后不会再出现",
        )

    async def rebuild(self, db: AsyncSession) -> LibraryRebuildOut:
        from app.modules.vault.paths import VAULT_CATEGORY_DIR

        root = library_root()
        removed = 0
        if root.exists():
            for child in list(root.iterdir()):
                # 手写笔记树与资源根同处，重建时绝不能清空
                if child.name == VAULT_CATEGORY_DIR:
                    continue
                if child.is_dir():
                    shutil.rmtree(child, ignore_errors=True)
                    removed += 1
                elif child.is_file() and child.name != ".gitkeep":
                    child.unlink(missing_ok=True)

        result = await db.execute(select(Source).order_by(Source.id.asc()))
        rows = list(result.scalars().all())
        synced = 0
        for row in rows:
            if (getattr(row, "vault_path", None) or "").strip():
                continue
            title = await self._title_for(db, row)
            path = sync_source_files(
                source_id=row.id,
                source_type=row.type or "",
                title=title,
            )
            if path is not None:
                synced += 1

        return LibraryRebuildOut(
            ok=True,
            synced=synced,
            removed=removed,
            message=(
                f"已同步 {synced} 项资源到「我的资源」。"
                f"「{VAULT_CATEGORY_DIR}」未改动。"
                "说明：重建按喂养来源重新生成目录；只删文件夹会被还原，请在列表中点删除。"
            ),
        )

    async def list_library(self, db: AsyncSession) -> LibraryOut:
        # 列表前轻量补齐：有 uploads 但没进 library 的条目
        result = await db.execute(select(Source).order_by(Source.id.asc()))
        rows = list(result.scalars().all())
        by_id = {row.id: row for row in rows}

        for row in rows:
            if (getattr(row, "vault_path", None) or "").strip():
                continue
            upload = _data_root() / "uploads" / str(row.id)
            if not upload.is_dir():
                continue
            if _find_existing_folder(row.id) is None and _collect_upload_files(upload):
                title = await self._title_for(db, row)
                sync_source_files(
                    source_id=row.id,
                    source_type=row.type or "",
                    title=title,
                )

        root = library_root()
        categories: list[LibraryCategoryOut] = []
        total = 0

        # 固定顺序展示；笔记库来自 data/library/笔记库 树
        ordered_labels = ["笔记库", "书籍", "视频", "网页", "笔记", "其它"]
        seen: set[str] = set()

        def build_vault_category() -> LibraryCategoryOut:
            nonlocal total
            from app.modules.vault.paths import vault_rel_prefix, vault_root

            vroot = vault_root()
            prefix = vault_rel_prefix()
            items: list[LibraryItemOut] = []

            def walk(folder: Path, rel_in_vault: str = "") -> None:
                if not folder.is_dir():
                    return
                for child in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
                    if child.name.startswith("."):
                        continue
                    rel = (
                        f"{rel_in_vault}/{child.name}".strip("/")
                        if rel_in_vault
                        else child.name
                    )
                    if child.is_dir():
                        walk(child, rel)
                        continue
                    if child.suffix.lower() != ".md":
                        continue
                    source_id = 0
                    title = child.stem
                    status = ""
                    for row in rows:
                        if (row.vault_path or "").replace("\\", "/") == rel.replace(
                            "\\", "/"
                        ):
                            source_id = int(row.id)
                            title = row.title or title
                            status = row.status or ""
                            break
                    items.append(
                        LibraryItemOut(
                            source_id=source_id,
                            title=title,
                            category="笔记库",
                            folder_name=rel,
                            folder_path=str(child.parent.relative_to(_data_root())).replace(
                                "\\", "/"
                            ),
                            absolute_path=str(child.resolve()),
                            type="note",
                            status=status,
                            files=[
                                LibraryFileOut(
                                    name=child.name,
                                    kind="original",
                                    size=child.stat().st_size if child.exists() else 0,
                                    path=str(child.relative_to(_data_root())).replace(
                                        "\\", "/"
                                    ),
                                )
                            ],
                        )
                    )

            walk(vroot)
            total += len(items)
            return LibraryCategoryOut(
                key="vault",
                label="笔记库",
                path=prefix,
                absolute_path=str(vroot.resolve()),
                item_count=len(items),
                items=items,
            )

        def build_category(label: str, path: Path) -> LibraryCategoryOut:
            nonlocal total
            items: list[LibraryItemOut] = []
            if path.is_dir():
                for folder in sorted(path.iterdir(), key=lambda p: p.name.lower()):
                    if not folder.is_dir():
                        continue
                    meta_path = folder / META_NAME
                    source_id = 0
                    title = folder.name
                    source_type = ""
                    if meta_path.is_file():
                        try:
                            data = json.loads(meta_path.read_text(encoding="utf-8"))
                            source_id = int(data.get("source_id") or 0)
                            title = str(data.get("title") or title)
                            source_type = str(data.get("type") or "")
                        except (OSError, json.JSONDecodeError, TypeError, ValueError):
                            pass

                    row = by_id.get(source_id)
                    files: list[LibraryFileOut] = []
                    for child in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
                        if not child.is_file() or child.name.startswith("."):
                            continue
                        rel = str(child.relative_to(_data_root())).replace("\\", "/")
                        files.append(
                            LibraryFileOut(
                                name=child.name,
                                kind=_file_kind(child.name),
                                size=child.stat().st_size if child.exists() else 0,
                                path=rel,
                            )
                        )
                    items.append(
                        LibraryItemOut(
                            source_id=source_id,
                            title=title,
                            category=label,
                            folder_name=folder.name,
                            folder_path=str(folder.relative_to(_data_root())).replace("\\", "/"),
                            absolute_path=str(folder.resolve()),
                            type=source_type or (row.type if row else ""),
                            status=row.status if row else "",
                            files=files,
                        )
                    )
            total += len(items)
            return LibraryCategoryOut(
                key=next(
                    (k for k, (_, lab) in CATEGORY_MAP.items() if lab == label),
                    "other",
                ),
                label=label,
                path=str(path.relative_to(_data_root())).replace("\\", "/"),
                absolute_path=str(path.resolve()),
                item_count=len(items),
                items=items,
            )

        for label in ordered_labels:
            if label == "笔记库":
                categories.append(build_vault_category())
                seen.add(label)
                continue
            path = root / label
            if path.is_dir() or label in {"书籍", "视频", "网页", "笔记"}:
                # 空分类也展示，方便用户打开目录
                if not path.exists():
                    path.mkdir(parents=True, exist_ok=True)
                categories.append(build_category(label, path))
                seen.add(label)

        if root.is_dir():
            for path in sorted(root.iterdir(), key=lambda p: p.name):
                if path.is_dir() and path.name not in seen:
                    categories.append(build_category(path.name, path))

        return LibraryOut(
            root_path=str(root.relative_to(_data_root())).replace("\\", "/"),
            absolute_root=str(root.resolve()),
            categories=categories,
            total_items=total,
        )


library_service = LibraryService()
