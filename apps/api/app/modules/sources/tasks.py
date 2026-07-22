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
