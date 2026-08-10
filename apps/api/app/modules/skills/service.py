"""Skill 安装、状态与对话注入。"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.knowledge.models import Entry
from app.modules.library.service import remove_source_from_library
from app.modules.skills.package import extract_and_validate_zip
from app.modules.skills.schemas import (
    SkillDetailOut,
    SkillInstallOut,
    SkillLeftoverListOut,
    SkillLeftoverOut,
    SkillListOut,
    SkillOut,
    SkillPurgeOut,
    SkillUninstallOut,
)
from app.modules.sources.models import Source
from app.modules.sources.schemas import PasteIn
from app.modules.sources.service import sources_service
from app.modules.sources.tasks import schedule_extract

# 导入附带材料时的标题前缀，便于卸载时成组清理
_SKILL_TITLE_RE = re.compile(r"^\[Skill[·•.]([a-z0-9][a-z0-9-]{1,62}[a-z0-9])\]\s*")

STATE_FILENAME = "skills-state.json"
MAX_INJECT_CHARS_TOTAL = 12_000
MAX_INJECT_PER_SKILL = 6_000
SKILL_SYSTEM_PREAMBLE = """

【已启用技能 · 仅约束流程与输出格式】
下列技能说明用于组织回答结构、检查清单或整理步骤（按用户设定的顺序排列）。
硬性约束：
1. 事实结论只能来自上方【资料片段】；技能正文不是知识来源。
2. 资料不足或无关时，仍须拒答；禁止根据技能说明编造领域事实、方剂、出处或未出现的结论。
3. 若技能要求特定输出结构，在「有依据可答」时遵守；拒答时用简洁拒答即可。
4. 多技能同时启用时：**越靠后的技能对最终成文格式优先级越高**。靠前的技能只做内心判断（如领域分流），不要在正文里输出「领域：」之类标签；靠后的总结/表达技能决定最终怎么写。
"""


def _skills_root() -> Path:
    root = Path(get_settings().data_dir).expanduser().resolve() / "skills"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _state_path() -> Path:
    return _skills_root() / STATE_FILENAME


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_state() -> dict[str, Any]:
    path = _state_path()
    if not path.is_file():
        return {"skills": {}, "order": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {"skills": {}, "order": []}
    if not isinstance(data, dict):
        return {"skills": {}, "order": []}
    skills = data.get("skills")
    order = data.get("order")
    if not isinstance(skills, dict):
        skills = {}
    if not isinstance(order, list):
        order = list(skills.keys())
    return {"skills": skills, "order": [str(x) for x in order]}


def _save_state(state: dict[str, Any]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _has_knowledge(skill_dir: Path) -> bool:
    kd = skill_dir / "knowledge"
    if not kd.is_dir():
        return False
    return any(
        p.is_file() and p.suffix.lower() in {".md", ".txt", ".markdown"}
        for p in kd.rglob("*")
    )


def _readme(skill_dir: Path) -> str:
    for name in ("README.md", "readme.md"):
        p = skill_dir / name
        if p.is_file():
            return p.read_text(encoding="utf-8", errors="replace")[:4000]
    return ""


def _to_out(skill_id: str, state: dict[str, Any]) -> SkillOut:
    skill_dir = _skills_root() / skill_id
    if not skill_dir.is_dir() or not (skill_dir / "skill.json").is_file():
        raise HTTPException(status_code=404, detail="技能未安装")
    meta = _read_json(skill_dir / "skill.json")
    st = state.get("skills", {}).get(skill_id) or {}
    installed_at = None
    raw_at = st.get("installed_at")
    if isinstance(raw_at, str) and raw_at:
        try:
            installed_at = datetime.fromisoformat(raw_at)
        except ValueError:
            installed_at = None
    return SkillOut(
        id=str(meta.get("id") or skill_id),
        name=str(meta.get("name") or skill_id),
        version=str(meta.get("version") or "0.0.0"),
        description=str(meta.get("description") or ""),
        type=str(meta.get("type") or "workflow"),  # type: ignore[arg-type]
        permissions=list(meta.get("permissions") or []),
        knowledge_policy=str(meta.get("knowledge_policy") or "library_only"),
        enabled=bool(st.get("enabled", True)),
        has_knowledge=_has_knowledge(skill_dir),
        knowledge_imported=bool(st.get("knowledge_imported", False)),
        installed_at=installed_at,
        author=str(meta.get("author") or ""),
        readme=_readme(skill_dir),
    )


class SkillsService:
    def list_skills(self) -> SkillListOut:
        state = _load_state()
        root = _skills_root()
        ids = [
            p.name
            for p in root.iterdir()
            if p.is_dir() and (p / "skill.json").is_file()
        ]
        order = [i for i in state.get("order", []) if i in ids]
        for i in ids:
            if i not in order:
                order.append(i)
        items = [_to_out(i, state) for i in order]
        return SkillListOut(items=items, total=len(items))

    def get_skill(self, skill_id: str) -> SkillDetailOut:
        state = _load_state()
        base = _to_out(skill_id, state)
        skill_dir = _skills_root() / skill_id
        meta = _read_json(skill_dir / "skill.json")
        entry = str(meta.get("entry") or "SKILL.md")
        entry_path = skill_dir / entry
        skill_md = ""
        if entry_path.is_file():
            skill_md = entry_path.read_text(encoding="utf-8", errors="replace")
        return SkillDetailOut(**base.model_dump(), entry=entry, skill_md=skill_md)

    async def install_upload(
        self,
        db: AsyncSession,
        *,
        file: UploadFile,
        import_knowledge: bool,
        background_tasks: BackgroundTasks | None,
        overwrite: bool = True,
    ) -> SkillInstallOut:
        import tempfile

        data = await file.read()
        root = _skills_root()
        tmp_parent = Path(tempfile.mkdtemp(prefix="kongku-skill-inst-"))
        skill_id = ""
        try:
            manifest, tmp_skill_dir = extract_and_validate_zip(data, tmp_parent)
            skill_id = manifest["id"]
            dest = root / skill_id
            if dest.exists() and not overwrite:
                raise HTTPException(status_code=409, detail=f"技能已安装：{skill_id}")
            if dest.exists():
                shutil.rmtree(dest)
            shutil.move(str(tmp_skill_dir), str(dest))
        finally:
            shutil.rmtree(tmp_parent, ignore_errors=True)

        if not skill_id:
            raise HTTPException(status_code=400, detail="安装失败")
        return await self._finalize_install(
            db,
            skill_id=skill_id,
            import_knowledge=import_knowledge,
            background_tasks=background_tasks,
        )

    async def _finalize_install(
        self,
        db: AsyncSession,
        *,
        skill_id: str,
        import_knowledge: bool,
        background_tasks: BackgroundTasks | None,
    ) -> SkillInstallOut:
        state = _load_state()
        skills = state.setdefault("skills", {})
        order = state.setdefault("order", [])
        prev = skills.get(skill_id) if isinstance(skills.get(skill_id), dict) else {}
        skills[skill_id] = {
            "enabled": True,
            "installed_at": _now_iso(),
            "version": _read_json(_skills_root() / skill_id / "skill.json").get("version", ""),
            "knowledge_imported": bool(prev.get("knowledge_imported", False)),
        }
        if skill_id not in order:
            order.append(skill_id)
        _save_state(state)

        queued = 0
        msg = "安装成功"
        if import_knowledge:
            queued = await self._import_knowledge(
                db, skill_id=skill_id, background_tasks=background_tasks
            )
            if queued:
                msg = f"安装成功，已将 {queued} 份附带材料送入喂养队列（需确认入库后才进入检索）"
            else:
                msg = "安装成功（本包无附带材料，或材料为空）"

        return SkillInstallOut(
            skill=_to_out(skill_id, _load_state()),
            knowledge_queued=queued,
            message=msg,
        )

    async def import_knowledge(
        self,
        db: AsyncSession,
        skill_id: str,
        background_tasks: BackgroundTasks | None,
    ) -> SkillInstallOut:
        _to_out(skill_id, _load_state())  # 存在性
        queued = await self._import_knowledge(
            db, skill_id=skill_id, background_tasks=background_tasks
        )
        return SkillInstallOut(
            skill=_to_out(skill_id, _load_state()),
            knowledge_queued=queued,
            message=f"已排队导入 {queued} 份材料" if queued else "没有可导入的附带材料",
        )

    async def _import_knowledge(
        self,
        db: AsyncSession,
        *,
        skill_id: str,
        background_tasks: BackgroundTasks | None,
    ) -> int:
        kd = _skills_root() / skill_id / "knowledge"
        if not kd.is_dir():
            return 0
        files = sorted(
            p
            for p in kd.rglob("*")
            if p.is_file() and p.suffix.lower() in {".md", ".txt", ".markdown"}
        )
        queued = 0
        for path in files:
            text = path.read_text(encoding="utf-8", errors="replace").strip()
            if not text:
                continue
            title = path.stem.strip() or path.name
            row = await sources_service.create_paste(
                db,
                PasteIn(title=f"[Skill·{skill_id}] {title}", content=text),
            )
            if background_tasks is not None:
                schedule_extract(background_tasks, row.id)
            queued += 1

        if queued:
            state = _load_state()
            st = state.setdefault("skills", {}).setdefault(skill_id, {})
            st["knowledge_imported"] = True
            _save_state(state)
        return queued

    def set_enabled(self, skill_id: str, enabled: bool) -> SkillOut:
        state = _load_state()
        _to_out(skill_id, state)
        st = state.setdefault("skills", {}).setdefault(skill_id, {})
        st["enabled"] = bool(enabled)
        _save_state(state)
        return _to_out(skill_id, _load_state())

    def reorder(self, order: list[str]) -> SkillListOut:
        """按传入 id 列表重排；未出现的已装技能追加到末尾。"""
        state = _load_state()
        root = _skills_root()
        installed = {
            p.name
            for p in root.iterdir()
            if p.is_dir() and (p / "skill.json").is_file()
        }
        seen: set[str] = set()
        new_order: list[str] = []
        for sid in order:
            sid = (sid or "").strip()
            if not sid or sid in seen or sid not in installed:
                continue
            seen.add(sid)
            new_order.append(sid)
        for sid in state.get("order", []):
            if sid in installed and sid not in seen:
                seen.add(sid)
                new_order.append(sid)
        for sid in sorted(installed):
            if sid not in seen:
                new_order.append(sid)
        state["order"] = new_order
        _save_state(state)
        return self.list_skills()

    def _title_prefix(self, skill_id: str) -> str:
        return f"[Skill·{skill_id}]"

    async def list_imported_leftovers(self, db: AsyncSession) -> SkillLeftoverListOut:
        """扫描喂养来源里仍残留的 Skill 导入材料（技能已卸也可能留下）。"""
        result = await db.execute(select(Source).order_by(Source.id.desc()))
        grouped: dict[str, list[str]] = {}
        for row in result.scalars().all():
            title = (row.title or "").strip()
            m = _SKILL_TITLE_RE.match(title)
            if not m:
                continue
            sid = m.group(1)
            grouped.setdefault(sid, []).append(title)
        items = [
            SkillLeftoverOut(skill_id=k, source_count=len(v), titles=v[:8])
            for k, v in sorted(grouped.items())
        ]
        return SkillLeftoverListOut(items=items)

    async def purge_imported(self, db: AsyncSession, skill_id: str) -> SkillPurgeOut:
        """删除某 Skill 导入产生的来源、知识条目与「我的资源」目录。"""
        skill_id = (skill_id or "").strip()
        if not skill_id:
            raise HTTPException(status_code=400, detail="skill_id 不能为空")
        prefix = self._title_prefix(skill_id)
        result = await db.execute(select(Source).where(Source.title.startswith(prefix)))
        rows = list(result.scalars().all())
        removed = 0
        data_root = Path(get_settings().data_dir).expanduser().resolve()
        for row in rows:
            sid = int(row.id)
            entries = await db.execute(select(Entry).where(Entry.source_id == sid))
            for entry in entries.scalars().all():
                await sources_service._remove_entry_tree(db, entry)
            await db.delete(row)
            await db.flush()
            upload = data_root / "uploads" / str(sid)
            if upload.exists():
                shutil.rmtree(upload, ignore_errors=True)
            remove_source_from_library(sid)
            removed += 1
        await db.commit()
        return SkillPurgeOut(
            skill_id=skill_id,
            removed=removed,
            message=(
                f"已清理 {removed} 条由该 Skill 导入的材料（含知识条目与资源目录）"
                if removed
                else "没有找到该 Skill 导入的残留材料"
            ),
        )

    async def uninstall(
        self,
        db: AsyncSession,
        skill_id: str,
        *,
        remove_imported: bool = True,
    ) -> SkillUninstallOut:
        state = _load_state()
        skill_dir = _skills_root() / skill_id
        installed = skill_dir.exists() or skill_id in state.get("skills", {})
        if not installed and not remove_imported:
            raise HTTPException(status_code=404, detail="技能未安装")

        removed = 0
        if remove_imported:
            purged = await self.purge_imported(db, skill_id)
            removed = purged.removed

        if skill_dir.exists():
            shutil.rmtree(skill_dir)
        state.get("skills", {}).pop(skill_id, None)
        state["order"] = [i for i in state.get("order", []) if i != skill_id]
        _save_state(state)

        if not installed and removed == 0:
            raise HTTPException(status_code=404, detail="技能未安装，且无残留导入材料")

        msg = "已卸载技能"
        if remove_imported:
            msg += f"；并清理导入材料 {removed} 条" if removed else "（无导入材料需清理）"
        return SkillUninstallOut(
            ok=True, id=skill_id, removed_imported=removed, message=msg
        )

    def build_system_addon(self) -> str:
        """供对话注入：已启用且含 chat.prompt 的 Skill 正文。"""
        state = _load_state()
        listed = self.list_skills().items
        blocks: list[str] = []
        used = 0
        for item in listed:
            if not item.enabled:
                continue
            if "chat.prompt" not in item.permissions:
                continue
            detail = self.get_skill(item.id)
            body = (detail.skill_md or "").strip()
            if not body:
                continue
            if len(body) > MAX_INJECT_PER_SKILL:
                body = body[:MAX_INJECT_PER_SKILL].rstrip() + "\n…（已截断）"
            chunk = f"### 技能：{item.name}（{item.id}）\n{body}"
            if used + len(chunk) > MAX_INJECT_CHARS_TOTAL:
                remain = MAX_INJECT_CHARS_TOTAL - used
                if remain < 200:
                    break
                chunk = chunk[:remain].rstrip() + "\n…（已截断）"
                blocks.append(chunk)
                break
            blocks.append(chunk)
            used += len(chunk)
        if not blocks:
            return ""
        return SKILL_SYSTEM_PREAMBLE + "\n\n" + "\n\n".join(blocks)


skills_service = SkillsService()
