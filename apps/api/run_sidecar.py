"""桌面端 API sidecar 入口：供 Electron / PyInstaller 启动。"""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.environ.get("KONGKU_API_HOST", "127.0.0.1")
    port = int(os.environ.get("KONGKU_API_PORT", "18765"))
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        log_level=os.environ.get("KONGKU_API_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
