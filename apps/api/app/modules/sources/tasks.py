"""后台抽取任务：在请求返回后用独立 Session 执行。"""

from __future__ import annotations

import asyncio
import logging
import random

from fastapi import BackgroundTasks

from app.core import database as db_mod
from app.modules.sources.extract_pool import enqueue_extract, set_extract_handler
from app.modules.sources.extractors import _resolve_cookie_file
from app.modules.sources.models import Source
from app.modules.sources.queue_control import is_queue_paused
from app.modules.sources.service import sources_service

logger = logging.getLogger(__name__)


def schedule_extract(
    background_tasks: BackgroundTasks | None, source_id: int
) -> bool:
    """把解析任务排进 FIFO 队列。

    并发上限由 worker 数控制（默认最多 2 路）；重试也会排到队尾。
    队列暂停时不入队。
    """
    if is_queue_paused():
        return False

    set_extract_handler(_run_extract_queued)

    if enqueue_extract(source_id):
        return True

    # 无 running loop 时（极少）：退回 BackgroundTasks，到 loop 里再入队
    if background_tasks is not None:
        background_tasks.add_task(_enqueue_via_background, source_id)
        return True
    logger.warning(
        "schedule_extract: no event loop and no BackgroundTasks id=%s", source_id
    )
    return False


async def _enqueue_via_background(source_id: int) -> None:
    set_extract_handler(_run_extract_queued)
    if is_queue_paused():
        return
    if not enqueue_extract(source_id):
        # 仍无 loop（不应发生）：直接跑，保底不丢任务
        await _run_extract_queued(source_id)


async def _playlist_delay_if_needed(source_id: int) -> None:
    """合集分集开跑前短暂间隔（占用当前 worker，保证 FIFO 不插队）。"""
    factory = db_mod.SessionLocal
    if factory is None:
        db_mod.init_engine_from_config()
        factory = db_mod.SessionLocal
    if factory is None:
        return
    async with factory() as db:
        row = await db.get(Source, source_id)
        if row is None or (getattr(row, "episode_no", 0) or 0) <= 0:
            return
        has_cookies = _resolve_cookie_file() is not None
        delay = random.uniform(0.5, 2.0) if has_cookies else random.uniform(3, 8)
    await asyncio.sleep(delay)


async def _run_extract_queued(source_id: int) -> None:
    """由 FIFO worker 调用：可选合集延时后执行抽取。"""
    try:
        if is_queue_paused():
            logger.info("queue paused, skip extract source_id=%s", source_id)
            return
        await _playlist_delay_if_needed(source_id)
        if is_queue_paused():
            logger.info("queue paused after delay, skip extract source_id=%s", source_id)
            return
        await run_extract_job(source_id)
    except Exception:  # noqa: BLE001
        logger.exception("extract job failed source_id=%s", source_id)


async def run_extract_job(source_id: int) -> None:
    """必须每次动态取 SessionLocal，避免切库热切换后仍用旧引擎。"""
    factory = db_mod.SessionLocal
    if factory is None:
        db_mod.init_engine_from_config()
        factory = db_mod.SessionLocal
    if factory is None:
        raise RuntimeError("数据库引擎未初始化")
    async with factory() as db:
        await sources_service.process_extract(db, source_id)


async def run_extract_then_ingest_job(source_id: int) -> None:
    """抽取完成后自动入库（公版书「直接入库」开关开启时使用）。"""
    try:
        if is_queue_paused():
            logger.info("queue paused, skip extract+ingest source_id=%s", source_id)
            return
        factory = db_mod.SessionLocal
        if factory is None:
            db_mod.init_engine_from_config()
            factory = db_mod.SessionLocal
        if factory is None:
            raise RuntimeError("数据库引擎未初始化")
        async with factory() as db:
            await sources_service.process_extract(db, source_id)
            row = await sources_service.get(db, source_id)
            if row.status == "ready":
                await sources_service.ingest(db, source_id)
            else:
                logger.warning(
                    "skip auto-ingest source_id=%s status=%s",
                    source_id,
                    row.status,
                )
    except Exception:  # noqa: BLE001
        logger.exception("extract+ingest job failed source_id=%s", source_id)
