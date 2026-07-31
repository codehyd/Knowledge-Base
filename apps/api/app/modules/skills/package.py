"""Skill 包校验与解压（声明式 Markdown，禁止可执行代码）。"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from fastapi import HTTPException

ALLOWED_TYPES = {"workflow", "persona", "toolkit"}
ALLOWED_PERMISSIONS = {"chat.prompt", "feed.pipeline", "export.template"}
REQUIRED_POLICY = "library_only"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+([+-][A-Za-z0-9.-]+)?$")

# 首期禁止可执行 / 脚本类文件进入包
FORBIDDEN_SUFFIXES = {
    ".py",
    ".pyc",
    ".pyo",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".sh",
    ".bash",
    ".zsh",
    ".bat",
    ".cmd",
    ".ps1",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".jar",
    ".wasm",
    ".php",
    ".rb",
    ".go",
    ".rs",
    ".c",
    ".cpp",
    ".o",
}

MAX_ZIP_BYTES = 20 * 1024 * 1024
MAX_SKILL_MD_CHARS = 40_000


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"skill.json 无法解析：{exc}") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="skill.json 必须是对象")
    return data


def validate_manifest(data: dict[str, Any]) -> dict[str, Any]:
    skill_id = str(data.get("id") or "").strip()
    name = str(data.get("name") or "").strip()
    version = str(data.get("version") or "").strip()
    entry = str(data.get("entry") or "SKILL.md").strip() or "SKILL.md"
    skill_type = str(data.get("type") or "workflow").strip()
    policy = str(data.get("knowledge_policy") or "").strip()
    perms_raw = data.get("permissions")
    if perms_raw is None:
        perms_raw = ["chat.prompt"]
    if not isinstance(perms_raw, list) or not all(isinstance(p, str) for p in perms_raw):
        raise HTTPException(status_code=400, detail="permissions 必须是字符串数组")
    permissions = [p.strip() for p in perms_raw if p and str(p).strip()]

    if not ID_RE.match(skill_id):
        raise HTTPException(
            status_code=400,
            detail="id 须为小写字母/数字/连字符，长度 3～64，且首尾非连字符",
        )
    if not name:
        raise HTTPException(status_code=400, detail="name 不能为空")
    if not SEMVER_RE.match(version):
        raise HTTPException(status_code=400, detail="version 须为 semver，如 1.0.0")
    if skill_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"type 仅支持：{', '.join(sorted(ALLOWED_TYPES))}",
        )
    if policy != REQUIRED_POLICY:
        raise HTTPException(
            status_code=400,
            detail=f"knowledge_policy 必须为 {REQUIRED_POLICY}（事实只认库内）",
        )
    bad = [p for p in permissions if p not in ALLOWED_PERMISSIONS]
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的权限：{', '.join(bad)}；允许：{', '.join(sorted(ALLOWED_PERMISSIONS))}",
        )
    if ".." in entry or entry.startswith("/") or "\\" in entry:
        raise HTTPException(status_code=400, detail="entry 路径非法")

    return {
        "id": skill_id,
        "name": name[:120],
        "version": version,
        "description": str(data.get("description") or "").strip()[:500],
        "type": skill_type,
        "entry": entry,
        "permissions": permissions or ["chat.prompt"],
        "knowledge_policy": REQUIRED_POLICY,
        "author": str(data.get("author") or "").strip()[:120],
        "min_app_version": str(data.get("min_app_version") or "").strip()[:32],
    }


def _find_package_root(extract_dir: Path) -> Path:
    """支持 zip 根即包，或单层目录包裹。"""
    direct = extract_dir / "skill.json"
    if direct.is_file():
        return extract_dir
    children = [p for p in extract_dir.iterdir() if not p.name.startswith("__MACOSX")]
    dirs = [p for p in children if p.is_dir()]
    files = [p for p in children if p.is_file()]
    if len(dirs) == 1 and not files:
        nested = dirs[0] / "skill.json"
        if nested.is_file():
            return dirs[0]
    raise HTTPException(status_code=400, detail="包内缺少 skill.json（可放在根目录或单层文件夹内）")


def _reject_forbidden_files(root: Path) -> None:
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if any(part.startswith(".") and part not in {".", ".."} for part in Path(rel).parts):
            # 允许无点文件；隐藏文件跳过检查但安装时会拷贝？更稳妥是跳过拷贝隐藏文件
            continue
        suffix = path.suffix.lower()
        if suffix in FORBIDDEN_SUFFIXES:
            raise HTTPException(
                status_code=400,
                detail=f"包内不允许可执行/脚本文件：{rel}（首期仅支持 Markdown/模板）",
            )


def _safe_copy_tree(src: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for path in src.rglob("*"):
        rel = path.relative_to(src)
        if any(part.startswith(".") for part in rel.parts):
            continue
        target = dest / rel
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif path.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def extract_and_validate_zip(data: bytes, dest_parent: Path) -> tuple[dict[str, Any], Path]:
    """校验 zip 并解压到 dest_parent/<id>/，返回 (manifest, skill_dir)。"""
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    if len(data) > MAX_ZIP_BYTES:
        raise HTTPException(status_code=400, detail="Skill 包超过 20MB 限制")

    tmp_root = Path(tempfile.mkdtemp(prefix="kongku-skill-"))
    try:
        zip_path = tmp_root / "pkg.zip"
        zip_path.write_bytes(data)
        extract_dir = tmp_root / "extracted"
        extract_dir.mkdir()
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                # 防 zip slip
                for info in zf.infolist():
                    name = info.filename.replace("\\", "/")
                    if name.startswith("/") or ".." in Path(name).parts:
                        raise HTTPException(status_code=400, detail="非法压缩路径")
                zf.extractall(extract_dir)
        except HTTPException:
            raise
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="不是有效的 zip 包") from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"解压失败：{exc}") from exc

        pkg_root = _find_package_root(extract_dir)
        _reject_forbidden_files(pkg_root)
        manifest = validate_manifest(_read_manifest(pkg_root / "skill.json"))
        entry_path = pkg_root / manifest["entry"]
        if not entry_path.is_file():
            raise HTTPException(status_code=400, detail=f"缺少入口文件：{manifest['entry']}")
        skill_md = entry_path.read_text(encoding="utf-8", errors="replace").strip()
        if not skill_md:
            raise HTTPException(status_code=400, detail="SKILL.md 不能为空")
        if len(skill_md) > MAX_SKILL_MD_CHARS:
            raise HTTPException(status_code=400, detail="SKILL.md 过长（上限约 4 万字）")

        skill_dir = dest_parent / manifest["id"]
        _safe_copy_tree(pkg_root, skill_dir)
        return manifest, skill_dir
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def validate_directory_package(pkg_root: Path) -> dict[str, Any]:
    """校验已展开的目录包（内置样例）。"""
    if not (pkg_root / "skill.json").is_file():
        raise HTTPException(status_code=400, detail="样例缺少 skill.json")
    _reject_forbidden_files(pkg_root)
    manifest = validate_manifest(_read_manifest(pkg_root / "skill.json"))
    entry_path = pkg_root / manifest["entry"]
    if not entry_path.is_file():
        raise HTTPException(status_code=400, detail=f"样例缺少入口：{manifest['entry']}")
    return manifest


def install_from_directory(src: Path, dest_parent: Path) -> tuple[dict[str, Any], Path]:
    manifest = validate_directory_package(src)
    if manifest["id"] != src.name and src.name not in {manifest["id"], "."}:
        # 允许目录名与 id 一致；不一致时仍按 manifest.id 安装
        pass
    skill_dir = dest_parent / manifest["id"]
    _safe_copy_tree(src, skill_dir)
    return manifest, skill_dir
