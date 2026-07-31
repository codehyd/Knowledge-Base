from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


SkillType = Literal["workflow", "persona", "toolkit"]


class SkillOut(BaseModel):
    id: str
    name: str
    version: str
    description: str = ""
    type: SkillType = "workflow"
    permissions: list[str] = Field(default_factory=list)
    knowledge_policy: str = "library_only"
    enabled: bool = True
    has_knowledge: bool = False
    knowledge_imported: bool = False
    installed_at: Optional[datetime] = None
    author: str = ""
    readme: str = ""


class SkillListOut(BaseModel):
    items: list[SkillOut]
    total: int


class SkillDetailOut(SkillOut):
    entry: str = "SKILL.md"
    skill_md: str = ""


class SkillEnableIn(BaseModel):
    enabled: bool


class SkillInstallOut(BaseModel):
    skill: SkillOut
    knowledge_queued: int = 0
    message: str = ""


class SkillUninstallOut(BaseModel):
    ok: bool = True
    id: str
    removed_imported: int = 0
    message: str = ""


class SkillPurgeIn(BaseModel):
    skill_id: str = Field(min_length=1, max_length=64)


class SkillPurgeOut(BaseModel):
    skill_id: str
    removed: int = 0
    message: str = ""


class SkillLeftoverOut(BaseModel):
    skill_id: str
    source_count: int = 0
    titles: list[str] = Field(default_factory=list)


class SkillLeftoverListOut(BaseModel):
    items: list[SkillLeftoverOut]

