"""笔记库：多级文件夹 + 保存自动入库。"""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.knowledge.index import index_entry
from app.modules.knowledge.models import Category, Chunk, Entry, EntryCategory
from app.modules.sources.classify import content_fingerprint, normalize_title_key
from app.modules.sources.models import Source
from app.modules.vault.paths import (
    data_root,
    note_filename,
    resolve_in_vault,
    to_vault_rel,
    vault_root,
)
from app.modules.vault.schemas import (
    VaultFolderIn,
    VaultImportIn,
    VaultNodeOut,
    VaultNodePatchIn,
    VaultNoteCreateIn,
    VaultNoteOut,
    VaultNoteSaveIn,
    VaultTreeOut,
)

SUMMARY_CHARS = 800


class VaultService:
    def ensure_root(self) -> Path:
        return vault_root()

    async def _path_map(self, db: AsyncSession) -> dict[str, Source]:
        result = await db.execute(
            select(Source).where(Source.vault_path != "", Source.vault_path.is_not(None))
        )
        out: dict[str, Source] = {}
        for row in result.scalars().all():
            key = (row.vault_path or "").replace("\\", "/").strip()
            if key:
                out[key] = row
        return out

    def _build_tree(self, folder: Path, path_map: dict[str, Source]) -> list[VaultNodeOut]:
        nodes: list[VaultNodeOut] = []
        if not folder.is_dir():
            return nodes
        entries = sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        for child in entries:
            if child.name.startswith("."):
                continue
            rel = to_vault_rel(child)
            if child.is_dir():
                nodes.append(
                    VaultNodeOut(
                        id=rel,
                        name=child.name,
                        kind="folder",
                        path=rel,
                        children=self._build_tree(child, path_map),
                    )
                )
            elif child.suffix.lower() == ".md":
                row = path_map.get(rel)
                title = (row.title if row else child.stem) or child.stem
                nodes.append(
                    VaultNodeOut(
                        id=rel,
                        name=child.name,
                        kind="note",
                        path=rel,
                        source_id=row.id if row else None,
                        title=title,
                        status=row.status if row else "",
                        children=[],
                    )
                )
        return nodes

    async def tree(self, db: AsyncSession) -> VaultTreeOut:
        root = self.ensure_root()
        path_map = await self._path_map(db)
        return VaultTreeOut(
            root="vault",
            absolute_root=str(root),
            nodes=self._build_tree(root, path_map),
        )

    async def create_folder(self, db: AsyncSession, payload: VaultFolderIn) -> VaultNodeOut:
        from app.modules.vault.paths import safe_segment

        parent = resolve_in_vault(payload.parent)
        if not parent.exists():
            raise HTTPException(status_code=404, detail="父目录不存在")
        if not parent.is_dir():
            raise HTTPException(status_code=400, detail="父路径不是文件夹")
        name = safe_segment(payload.name)
        dest = parent / name
        if dest.exists():
            raise HTTPException(status_code=409, detail="同名文件夹已存在")
        dest.mkdir(parents=False)
        rel = to_vault_rel(dest)
        return VaultNodeOut(id=rel, name=name, kind="folder", path=rel, children=[])

    def _unique_note_path(self, parent: Path, title: str) -> Path:
        filename = note_filename(title)
        dest = parent / filename
        if not dest.exists():
            return dest
        stem = Path(filename).stem
        for i in range(2, 200):
            candidate = parent / f"{stem}-{i}.md"
            if not candidate.exists():
                return candidate
        raise HTTPException(status_code=409, detail="无法生成唯一文件名")

    async def create_note(self, db: AsyncSession, payload: VaultNoteCreateIn) -> VaultNoteOut:
        parent = resolve_in_vault(payload.parent)
        if not parent.exists() or not parent.is_dir():
            raise HTTPException(status_code=404, detail="父目录不存在")
        title = (payload.title or "未命名笔记").strip()[:200] or "未命名笔记"
        dest = self._unique_note_path(parent, title)
        content = f"# {title}\n\n"
        dest.write_text(content, encoding="utf-8")
        rel = to_vault_rel(dest)

        row = Source(
            type="note",
            title=title,
            filename=dest.name,
            status="ready",
            stage="vault",
            progress=100,
            storage_path=str(dest.relative_to(data_root())).replace("\\", "/"),
            vault_path=rel,
            char_count=len(content),
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)

        # 抽取副本
        folder = data_root() / "uploads" / str(row.id)
        folder.mkdir(parents=True, exist_ok=True)
        text_file = folder / "extracted.txt"
        text_file.write_text(content, encoding="utf-8")
        row.text_path = str(text_file.relative_to(data_root())).replace("\\", "/")
        await db.commit()
        await db.refresh(row)

        return VaultNoteOut(
            source_id=row.id,
            title=row.title,
            path=rel,
            content=content,
            status=row.status,
            committed=False,
            char_count=row.char_count,
        )

    async def _get_vault_source(self, db: AsyncSession, source_id: int) -> Source:
        row = await db.get(Source, source_id)
        if not row or row.type != "note":
            raise HTTPException(status_code=404, detail="笔记不存在")
        if not (row.vault_path or "").strip():
            raise HTTPException(status_code=400, detail="该笔记不在笔记库中，请先导入")
        return row

    async def get_note(self, db: AsyncSession, source_id: int) -> VaultNoteOut:
        row = await self._get_vault_source(db, source_id)
        path = resolve_in_vault(row.vault_path)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="笔记文件缺失")
        content = path.read_text(encoding="utf-8", errors="ignore")
        return VaultNoteOut(
            source_id=row.id,
            title=row.title or path.stem,
            path=row.vault_path,
            content=content,
            status=row.status or "",
            committed=row.status == "committed",
            char_count=len(content),
        )

    async def _ensure_category(self, db: AsyncSession, name: str) -> Category:
        result = await db.execute(select(Category).where(Category.name == name))
        cat = result.scalar_one_or_none()
        if cat:
            return cat
        cat = Category(name=name)
        db.add(cat)
        await db.flush()
        return cat

    async def _auto_commit(self, db: AsyncSession, row: Source, text: str) -> None:
        """保存后自动入库或重切片（不做 LLM 归类，固定「笔记库」标签）。"""
        text = text.strip()
        if not text:
            return
        title = (row.title or "未命名笔记").strip()[:500]
        digest = content_fingerprint(text)

        result = await db.execute(select(Entry).where(Entry.source_id == row.id).limit(1))
        entry = result.scalar_one_or_none()
        if entry is None:
            entry = Entry(
                title=title,
                summary=text[:SUMMARY_CHARS].strip(),
                source_id=row.id,
                title_key=normalize_title_key(title),
                content_hash=digest,
            )
            db.add(entry)
            await db.flush()
            cat = await self._ensure_category(db, "笔记库")
            db.add(EntryCategory(entry_id=entry.id, category_id=cat.id))
        else:
            entry.title = title
            entry.title_key = normalize_title_key(title)
            entry.content_hash = digest
            if len((entry.summary or "").strip()) < 8:
                entry.summary = text[:SUMMARY_CHARS].strip()

        row.status = "committed"
        row.stage = "vault_synced"
        row.progress = 100
        row.error_message = ""
        await db.commit()
        await db.refresh(entry)
        try:
            await index_entry(db, entry.id, with_embed=True)
        except Exception:
            pass

    async def save_note(
        self, db: AsyncSession, source_id: int, payload: VaultNoteSaveIn
    ) -> VaultNoteOut:
        row = await self._get_vault_source(db, source_id)
        path = resolve_in_vault(row.vault_path)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="笔记文件缺失")

        content = (payload.content or "").replace("\r\n", "\n")
        title = (payload.title or "").strip()
        if not title:
            first = content.splitlines()[0].lstrip("# ").strip() if content.strip() else ""
            title = first[:80] or path.stem or "未命名笔记"
        title = title[:500]

        path.write_text(content, encoding="utf-8")
        folder = data_root() / "uploads" / str(row.id)
        folder.mkdir(parents=True, exist_ok=True)
        text_file = folder / "extracted.txt"
        text_file.write_text(content, encoding="utf-8")

        row.title = title
        row.filename = path.name
        row.storage_path = str(path.relative_to(data_root())).replace("\\", "/")
        row.text_path = str(text_file.relative_to(data_root())).replace("\\", "/")
        row.char_count = len(content)
        await db.commit()
        await db.refresh(row)

        if content.strip():
            await self._auto_commit(db, row, content)
            await db.refresh(row)

        return VaultNoteOut(
            source_id=row.id,
            title=row.title,
            path=row.vault_path,
            content=content,
            status=row.status or "",
            committed=row.status == "committed",
            char_count=len(content),
        )

    async def patch_node(self, db: AsyncSession, payload: VaultNodePatchIn) -> VaultNodeOut:
        src = resolve_in_vault(payload.path)
        if not src.exists():
            raise HTTPException(status_code=404, detail="路径不存在")
        is_dir = src.is_dir()
        new_name = payload.new_name
        if new_name is not None:
            from app.modules.vault.paths import safe_segment

            new_name = safe_segment(new_name)
            if not is_dir and not new_name.lower().endswith(".md"):
                new_name = f"{new_name}.md"

        parent_rel = payload.new_parent
        if parent_rel is None:
            parent = src.parent
        else:
            parent = resolve_in_vault(parent_rel)
            if not parent.is_dir():
                raise HTTPException(status_code=400, detail="目标父目录无效")

        dest_name = new_name if new_name is not None else src.name
        dest = parent / dest_name
        if dest.resolve() == src.resolve():
            rel = to_vault_rel(src)
            return VaultNodeOut(
                id=rel,
                name=src.name,
                kind="folder" if is_dir else "note",
                path=rel,
                children=[],
            )
        if dest.exists():
            raise HTTPException(status_code=409, detail="目标已存在")

        old_rel = to_vault_rel(src)
        src.rename(dest)
        new_rel = to_vault_rel(dest)

        path_map = await self._path_map(db)
        touched: Source | None = path_map.get(old_rel)
        for key, row in list(path_map.items()):
            if key == old_rel or key.startswith(old_rel + "/"):
                suffix = key[len(old_rel) :]
                row.vault_path = f"{new_rel}{suffix}"
                note_file = resolve_in_vault(row.vault_path)
                if note_file.is_file():
                    row.storage_path = str(note_file.relative_to(data_root())).replace(
                        "\\", "/"
                    )
                    row.filename = note_file.name
                    if key == old_rel and new_name and not is_dir:
                        row.title = Path(new_name).stem
        await db.commit()

        return VaultNodeOut(
            id=new_rel,
            name=dest.name,
            kind="folder" if is_dir else "note",
            path=new_rel,
            source_id=touched.id if touched else None,
            title=(touched.title if touched else dest.stem),
            status=(touched.status if touched else ""),
            children=[],
        )

    async def delete_note(self, db: AsyncSession, source_id: int) -> dict:
        row = await self._get_vault_source(db, source_id)
        path = resolve_in_vault(row.vault_path)
        sid = int(row.id)

        result = await db.execute(select(Entry).where(Entry.source_id == sid))
        for entry in result.scalars().all():
            chunks = await db.execute(select(Chunk).where(Chunk.entry_id == entry.id))
            for chunk in chunks.scalars().all():
                await db.delete(chunk)
            cats = await db.execute(
                select(EntryCategory).where(EntryCategory.entry_id == entry.id)
            )
            for link in cats.scalars().all():
                await db.delete(link)
            await db.delete(entry)

        await db.delete(row)
        await db.commit()

        if path.is_file():
            path.unlink(missing_ok=True)
        upload = data_root() / "uploads" / str(sid)
        if upload.exists():
            shutil.rmtree(upload, ignore_errors=True)

        return {"ok": True, "source_id": sid}

    async def delete_folder(self, db: AsyncSession, rel: str) -> dict:
        folder = resolve_in_vault(rel)
        if not folder.is_dir():
            raise HTTPException(status_code=400, detail="不是文件夹")
        if folder.resolve() == vault_root():
            raise HTTPException(status_code=400, detail="不能删除笔记库根目录")

        # 删除文件夹内所有 vault 笔记
        path_map = await self._path_map(db)
        prefix = to_vault_rel(folder)
        to_delete = [
            row
            for key, row in path_map.items()
            if key == prefix or key.startswith(prefix + "/")
        ]
        for row in to_delete:
            await self.delete_note(db, row.id)

        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)
        return {"ok": True, "path": prefix}

    async def import_source(self, db: AsyncSession, payload: VaultImportIn) -> VaultNoteOut:
        """把非 vault 笔记导入笔记库根/指定目录，便于独立编辑器打开。"""
        row = await db.get(Source, payload.source_id)
        if not row or row.type != "note":
            raise HTTPException(status_code=404, detail="仅笔记可导入笔记库")
        if (row.vault_path or "").strip():
            return await self.get_note(db, row.id)

        content = ""
        if row.storage_path:
            p = data_root() / row.storage_path
            if p.is_file():
                content = p.read_text(encoding="utf-8", errors="ignore")
        if not content.strip() and row.text_path:
            p = data_root() / row.text_path
            if p.is_file():
                content = p.read_text(encoding="utf-8", errors="ignore")
        if not content.strip():
            content = f"# {row.title or '未命名笔记'}\n\n"

        parent = resolve_in_vault(payload.parent)
        if not parent.is_dir():
            raise HTTPException(status_code=404, detail="父目录不存在")
        title = (row.title or "未命名笔记").strip()[:200] or "未命名笔记"
        dest = self._unique_note_path(parent, title)
        dest.write_text(content, encoding="utf-8")
        rel = to_vault_rel(dest)

        row.vault_path = rel
        row.storage_path = str(dest.relative_to(data_root())).replace("\\", "/")
        row.filename = dest.name
        row.char_count = len(content)
        folder = data_root() / "uploads" / str(row.id)
        folder.mkdir(parents=True, exist_ok=True)
        text_file = folder / "extracted.txt"
        text_file.write_text(content, encoding="utf-8")
        row.text_path = str(text_file.relative_to(data_root())).replace("\\", "/")
        await db.commit()
        await db.refresh(row)

        if content.strip():
            await self._auto_commit(db, row, content)
            await db.refresh(row)

        return VaultNoteOut(
            source_id=row.id,
            title=row.title,
            path=rel,
            content=content,
            status=row.status or "",
            committed=row.status == "committed",
            char_count=len(content),
        )


vault_service = VaultService()
