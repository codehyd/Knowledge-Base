"""后台对话任务：请求返回后用独立 Session 完成检索与生成。"""

from __future__ import annotations

import logging

from app.core import database as db_mod
from app.modules.chat.service import chat_service

logger = logging.getLogger(__name__)


async def run_chat_job(assistant_message_id: int) -> None:
    """必须每次动态取 SessionLocal，避免切库热切换后仍用旧引擎。"""
    try:
        factory = db_mod.SessionLocal
        if factory is None:
            db_mod.init_engine_from_config()
            factory = db_mod.SessionLocal
        if factory is None:
            raise RuntimeError("数据库引擎未初始化")
        async with factory() as db:
            await chat_service.complete_pending(db, assistant_message_id)
    except Exception:  # noqa: BLE001
        logger.exception("chat job failed assistant_message_id=%s", assistant_message_id)
