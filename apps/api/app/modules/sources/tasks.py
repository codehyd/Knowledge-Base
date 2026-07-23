"""后台抽取任务：在请求返回后用独立 Session 执行。"""

from __future__ import annotations

import logging

from app.core import database as db_mod
from app.modules.sources.service import sources_service

logger = logging.getLogger(__name__)


async def run_extract_job(source_id: int) -> None:
    """必须每次动态取 SessionLocal，避免切库热切换后仍用旧引擎。"""
    try:
        factory = db_mod.SessionLocal
        if factory is None:
            db_mod.init_engine_from_config()
            factory = db_mod.SessionLocal
        if factory is None:
            raise RuntimeError("数据库引擎未初始化")
        async with factory() as db:
            await sources_service.process_extract(db, source_id)
    except Exception:  # noqa: BLE001
        logger.exception("extract job failed source_id=%s", source_id)


async def run_extract_then_ingest_job(source_id: int) -> None:
    """抽取完成后自动入库（公版书「直接入库」开关开启时使用）。"""
    try:
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
