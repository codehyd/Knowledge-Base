"""
用 PyInstaller 打包 kongku-api sidecar，输出到 apps/desktop/resources/api/

用法（在 apps/api 下，已激活 venv）：
  pip install pyinstaller
  python scripts/build_sidecar.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = API_ROOT.parent.parent
OUT_DIR = REPO_ROOT / "apps" / "desktop" / "resources" / "api"
ENTRY = API_ROOT / "run_sidecar.py"
NAME = "kongku-api"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # 清理旧产物，避免混入过期二进制
    for old in OUT_DIR.glob("kongku-api*"):
        if old.is_file():
            old.unlink()
        elif old.is_dir():
            shutil.rmtree(old, ignore_errors=True)

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        NAME,
        "--distpath",
        str(OUT_DIR),
        "--workpath",
        str(API_ROOT / "build" / "pyinstaller" / "work"),
        "--specpath",
        str(API_ROOT / "build" / "pyinstaller"),
        # FastAPI / SQLAlchemy / 提取链路常见动态导入
        "--collect-all",
        "uvicorn",
        "--collect-all",
        "fastapi",
        "--collect-all",
        "starlette",
        "--collect-all",
        "pydantic",
        "--collect-all",
        "asyncpg",
        "--collect-all",
        "aiosqlite",
        "--hidden-import",
        "app.main",
        "--hidden-import",
        "app.modules.health.router",
        "--hidden-import",
        "app.modules.overview.router",
        "--hidden-import",
        "app.modules.settings_ai.router",
        "--hidden-import",
        "app.modules.settings_db.router",
        "--hidden-import",
        "app.modules.sources.router",
        "--hidden-import",
        "app.modules.knowledge.router",
        "--hidden-import",
        "app.modules.chat.router",
        str(ENTRY),
    ]

    print("Running:", " ".join(cmd))
    subprocess.check_call(cmd, cwd=str(API_ROOT))
    print(f"Sidecar written to: {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
