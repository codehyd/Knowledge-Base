"""Skill 模块冒烟：包校验 / 本地安装 / 注入 / 禁脚本。"""

from __future__ import annotations

import asyncio
import io
import json
import os
import tempfile
import zipfile
from pathlib import Path

os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="kongku-skill-test-")

from app.modules.skills.package import (  # noqa: E402
    extract_and_validate_zip,
    install_from_directory,
    validate_manifest,
)
from app.modules.skills.service import skills_service  # noqa: E402


def _write_demo_skill(root: Path) -> Path:
    skill_dir = root / "demo-flow"
    skill_dir.mkdir(parents=True)
    (skill_dir / "skill.json").write_text(
        json.dumps(
            {
                "id": "demo-flow",
                "name": "演示流程",
                "version": "1.0.0",
                "description": "smoke only",
                "type": "workflow",
                "entry": "SKILL.md",
                "permissions": ["chat.prompt"],
                "knowledge_policy": "library_only",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (skill_dir / "SKILL.md").write_text(
        "# 演示\n\n有资料时分点作答；无资料必须拒答。\n",
        encoding="utf-8",
    )
    return skill_dir


async def main() -> None:
    src = _write_demo_skill(Path(tempfile.mkdtemp(prefix="kongku-skill-src-")))
    install_from_directory(src, Path(os.environ["DATA_DIR"]) / "skills")

    from app.modules.skills import service as svc

    state = svc._load_state()
    state["skills"]["demo-flow"] = {
        "enabled": True,
        "installed_at": svc._now_iso(),
        "version": "1.0.0",
        "knowledge_imported": False,
    }
    state["order"] = ["demo-flow"]
    svc._save_state(state)

    listed = skills_service.list_skills()
    assert any(x.id == "demo-flow" for x in listed.items)

    addon = skills_service.build_system_addon()
    assert "演示" in addon or "demo-flow" in addon
    print("addon_len", len(addon))

    skills_service.set_enabled("demo-flow", False)
    assert skills_service.build_system_addon() == ""
    skills_service.uninstall("demo-flow")

    try:
        validate_manifest(
            {
                "id": "bad-skill",
                "name": "x",
                "version": "1.0.0",
                "type": "workflow",
                "knowledge_policy": "open",
                "permissions": ["chat.prompt"],
            }
        )
        raise AssertionError("should fail policy")
    except Exception as exc:  # noqa: BLE001
        print("policy_reject", getattr(exc, "detail", exc))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "skill.json",
            (
                '{"id":"evil-skill","name":"evil","version":"1.0.0",'
                '"type":"workflow","permissions":["chat.prompt"],'
                '"knowledge_policy":"library_only","entry":"SKILL.md"}'
            ),
        )
        zf.writestr("SKILL.md", "hello")
        zf.writestr("hack.py", "print(1)")
    try:
        extract_and_validate_zip(buf.getvalue(), Path(tempfile.mkdtemp()))
        raise AssertionError("should reject py")
    except Exception as exc:  # noqa: BLE001
        print("py_reject", getattr(exc, "detail", exc))

    print("ALL_PASS")


if __name__ == "__main__":
    asyncio.run(main())
