"""喂养解析队列：开始 / 暂停（进程内状态 + 落盘，重启后仍生效）。"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from app.core.config import get_settings

_RUNTIME_NAME = "runtime-queue.json"
_lock = threading.Lock()
_paused: bool | None = None


def _path() -> Path:
    return Path(get_settings().data_dir).expanduser().resolve() / _RUNTIME_NAME


def _load() -> bool:
    path = _path()
    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return bool(data.get("paused"))


def _save(paused: bool) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"paused": paused}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def is_queue_paused() -> bool:
    global _paused
    with _lock:
        if _paused is None:
            _paused = _load()
        return _paused


def set_queue_paused(paused: bool) -> bool:
    global _paused
    with _lock:
        _paused = bool(paused)
        _save(_paused)
        return _paused
