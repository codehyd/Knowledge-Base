"""后台抽取任务：在请求返回后用独立 Session 执行。"""

from __future__ import annotations

import logging

from app.core.database import SessionLocal
from app.modules.sources.service import sources_service

logger = logging.getLogger(__name__)


async def run_extract_job(source_id: int) -> None:
    try:
        async with SessionLocal() as db:
            await sources_service.process_extract(db, source_id)
    except Exception:  # noqa: BLE001
        logger.exception("extract job failed source_id=%s", source_id)
