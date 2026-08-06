"""解析任务并发池（保守上限）。

默认最多 2 路同时跑抽取管线；本地 Whisper 另有推理锁（见 asr.py）。
可用环境变量覆盖：

  KONGKU_EXTRACT_CONCURRENCY=1|2   （默认 2，硬顶 2）
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator, Awaitable, Callable

logger = logging.getLogger(__name__)

_sem: asyncio.Semaphore | None = None
_sem_n: int | None = None
_tasks: set[asyncio.Task] = set()


def extract_concurrency() -> int:
    raw = (os.environ.get("KONGKU_EXTRACT_CONCURRENCY") or "2").strip()
    try:
        n = int(raw)
    except ValueError:
        n = 2
    return max(1, min(2, n))


def _semaphore() -> asyncio.Semaphore:
    global _sem, _sem_n
    n = extract_concurrency()
    if _sem is None or _sem_n != n:
        _sem = asyncio.Semaphore(n)
        _sem_n = n
        logger.info("extract pool concurrency=%s", n)
    return _sem


@asynccontextmanager
async def acquire_extract_slot() -> AsyncIterator[None]:
    async with _semaphore():
        yield


def spawn_extract(coro_factory: Callable[[], Awaitable[None]]) -> bool:
    """在当前事件循环投递任务；并发上限由 acquire_extract_slot 控制。"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False

    async def _runner() -> None:
        await coro_factory()

    task = loop.create_task(_runner())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return True
