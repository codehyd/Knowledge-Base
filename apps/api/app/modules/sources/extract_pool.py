"""解析任务 FIFO 队列（保守并发）。

最多 N 路同时跑抽取管线（默认 2，硬顶 2）；任务按入队顺序执行。
失败重试也会排到队尾，不会插队抢正在等待的项。

环境变量：KONGKU_EXTRACT_CONCURRENCY=1|2（默认 2）
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable

logger = logging.getLogger(__name__)

_queue: asyncio.Queue[int] | None = None
_queued_ids: set[int] = set()
_active_ids: set[int] = set()
_workers: list[asyncio.Task] = []
_worker_n: int | None = None
_handler: Callable[[int], Awaitable[None]] | None = None


def extract_concurrency() -> int:
    raw = (os.environ.get("KONGKU_EXTRACT_CONCURRENCY") or "2").strip()
    try:
        n = int(raw)
    except ValueError:
        n = 2
    return max(1, min(2, n))


def set_extract_handler(handler: Callable[[int], Awaitable[None]]) -> None:
    """注册实际执行抽取的协程工厂（由 tasks 模块注入，避免循环导入）。"""
    global _handler
    _handler = handler


def queue_snapshot() -> dict[str, int]:
    return {
        "concurrency": extract_concurrency(),
        "queued": len(_queued_ids),
        "active": len(_active_ids),
    }


def _ensure_workers() -> asyncio.Queue[int]:
    global _queue, _workers, _worker_n
    try:
        asyncio.get_running_loop()
    except RuntimeError as exc:
        raise RuntimeError("extract queue requires a running event loop") from exc

    n = extract_concurrency()
    if _queue is None:
        _queue = asyncio.Queue()
    if _workers and _worker_n == n and all(not t.done() for t in _workers):
        return _queue

    # 并发配置变化或 worker 挂了：停旧的、起新的（队列里的任务保留）
    for t in _workers:
        if not t.done():
            t.cancel()
    _workers = []
    _worker_n = n
    for i in range(n):
        task = asyncio.create_task(_worker_loop(i), name=f"extract-worker-{i}")
        _workers.append(task)
    logger.info("extract FIFO workers started concurrency=%s", n)
    return _queue


async def _worker_loop(worker_id: int) -> None:
    assert _queue is not None
    while True:
        source_id = await _queue.get()
        _queued_ids.discard(source_id)
        _active_ids.add(source_id)
        try:
            from app.modules.sources.queue_control import is_queue_paused

            if is_queue_paused():
                logger.info(
                    "extract worker-%s skip paused source_id=%s", worker_id, source_id
                )
                continue
            if _handler is None:
                logger.error("extract handler not set, drop source_id=%s", source_id)
                continue
            await _handler(source_id)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception(
                "extract worker-%s failed source_id=%s", worker_id, source_id
            )
        finally:
            _active_ids.discard(source_id)
            _queue.task_done()


def enqueue_extract(source_id: int) -> bool:
    """将 source_id 排到队尾；已在队中或正在跑的不重复入队。"""
    try:
        q = _ensure_workers()
    except RuntimeError:
        return False

    if source_id in _queued_ids or source_id in _active_ids:
        logger.info("extract already queued/active source_id=%s", source_id)
        return True

    _queued_ids.add(source_id)
    q.put_nowait(source_id)
    logger.info(
        "extract enqueued source_id=%s queued=%s active=%s",
        source_id,
        len(_queued_ids),
        len(_active_ids),
    )
    return True


# 兼容旧名：历史上 create_task + Semaphore
def spawn_extract(coro_factory: Callable[[], Awaitable[None]]) -> bool:
    """已废弃：请用 enqueue_extract。保留以免外部误用直接炸掉。"""
    del coro_factory
    return False
