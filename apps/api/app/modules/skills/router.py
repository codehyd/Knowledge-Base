from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.skills.schemas import (
    SkillDetailOut,
    SkillEnableIn,
    SkillInstallOut,
    SkillLeftoverListOut,
    SkillListOut,
    SkillOut,
    SkillPurgeIn,
    SkillPurgeOut,
    SkillUninstallOut,
)
from app.modules.skills.service import skills_service

router = APIRouter(prefix="/skills", tags=["技能 Skill"])


@router.get(
    "",
    response_model=SkillListOut,
    summary="已安装技能列表",
)
async def list_skills() -> SkillListOut:
    return skills_service.list_skills()


@router.get(
    "/imported-leftovers",
    response_model=SkillLeftoverListOut,
    summary="扫描 Skill 导入残留",
    description="即使技能已卸载，仍可能留下喂养来源 / 知识条目 / 我的资源目录。",
)
async def list_imported_leftovers(
    db: AsyncSession = Depends(get_db),
) -> SkillLeftoverListOut:
    return await skills_service.list_imported_leftovers(db)


@router.post(
    "/purge-imported",
    response_model=SkillPurgeOut,
    summary="清理某 Skill 导入的材料",
    description="按标题前缀 [Skill·id] 删除来源、知识条目与资源目录；不要求技能仍安装。",
)
async def purge_imported(
    payload: SkillPurgeIn,
    db: AsyncSession = Depends(get_db),
) -> SkillPurgeOut:
    return await skills_service.purge_imported(db, payload.skill_id)


@router.post(
    "/install",
    response_model=SkillInstallOut,
    summary="从本地 zip 安装技能",
    description="上传 .kongku-skill.zip 或普通 zip；须含 skill.json + SKILL.md；knowledge_policy 必须为 library_only。",
)
async def install_skill(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    import_knowledge: bool = Form(False),
    overwrite: bool = Form(True),
    db: AsyncSession = Depends(get_db),
) -> SkillInstallOut:
    return await skills_service.install_upload(
        db,
        file=file,
        import_knowledge=import_knowledge,
        background_tasks=background_tasks,
        overwrite=overwrite,
    )


@router.get(
    "/{skill_id}",
    response_model=SkillDetailOut,
    summary="技能详情（含 SKILL.md）",
)
async def get_skill(skill_id: str) -> SkillDetailOut:
    return skills_service.get_skill(skill_id)


@router.patch(
    "/{skill_id}",
    response_model=SkillOut,
    summary="启用 / 禁用技能",
)
async def patch_skill(skill_id: str, payload: SkillEnableIn) -> SkillOut:
    return skills_service.set_enabled(skill_id, payload.enabled)


@router.post(
    "/{skill_id}/import-knowledge",
    response_model=SkillInstallOut,
    summary="导入包内附带材料到喂养队列",
    description="不会绕过入库流程；导入后仍需解析与确认入库，检索才可见。",
)
async def import_knowledge(
    skill_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> SkillInstallOut:
    return await skills_service.import_knowledge(db, skill_id, background_tasks)


@router.delete(
    "/{skill_id}",
    response_model=SkillUninstallOut,
    summary="卸载技能",
    description="默认同时清理该 Skill 导入的材料（来源 / 知识条目 / 我的资源）。传 remove_imported=false 可只卸技能。",
)
async def uninstall_skill(
    skill_id: str,
    remove_imported: bool = True,
    db: AsyncSession = Depends(get_db),
) -> SkillUninstallOut:
    return await skills_service.uninstall(
        db, skill_id, remove_imported=remove_imported
    )
