"""后台抽取任务：在请求返回后用独立 Session 执行。"""

from __future__ import annotations

import asyncio
import logging
import random

from fastapi import BackgroundTasks

from app.core import database as db_mod
from app.modules.sources.extract_pool import spawn_extract
from app.modules.sources.extractors import _resolve_cookie_file
from app.modules.sources.models import Source
from app.modules.sources.queue_control import is_queue_paused
from app.modules.sources.service import sources_service

logger = logging.getLogger(__name__)


def schedule_extract(
    background_tasks: BackgroundTasks | None, source_id: int
) -> bool:
    """投递解析任务。

    优先丢进事件循环并发池（最多 2 路）；无 running loop 时回退 BackgroundTasks。
    队列暂停时不调度。
    """
    if is_queue_paused():
        return False

    if spawn_extract(lambda: _run_extract_pooled(source_id)):
        return True

    if background_tasks is not None:
        background_tasks.add_task(_run_extract_pooled, source_id)
        return True
    logger.warning(
        "schedule_extract: no event loop and no BackgroundTasks id=%s", source_id
    )
    return False


async def _playlist_delay_if_needed(source_id: int) -> None:
    """合集分集开跑前短暂间隔，不占用并发槽。"""
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


async def _run_extract_pooled(source_id: int) -> None:
    """带并发槽的抽取：先延时，再进池执行。"""
    from app.modules.sources.extract_pool import acquire_extract_slot

    try:
        if is_queue_paused():
            logger.info("queue paused, skip extract source_id=%s", source_id)
            return
        await _playlist_delay_if_needed(source_id)
        if is_queue_paused():
            logger.info("queue paused after delay, skip extract source_id=%s", source_id)
            return
        async with acquire_extract_slot():
            if is_queue_paused():
                logger.info(
                    "queue paused before work, skip extract source_id=%s", source_id
                )
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
