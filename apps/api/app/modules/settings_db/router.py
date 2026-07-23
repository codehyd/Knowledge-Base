from fastapi import APIRouter, HTTPException

from app.modules.settings_db.schemas import (
    DbInitOut,
    DbSettingsOut,
    DbSettingsUpdate,
    DbTestOut,
    DbTestRequest,
)
from app.modules.settings_db.service import settings_db_service

router = APIRouter(prefix="/settings/db", tags=["数据库配置"])


@router.get(
    "",
    response_model=DbSettingsOut,
    summary="读取当前数据库配置",
    description="连接配置保存在 data/runtime-db.json（不在业务库内）。含表结构是否就绪。",
)
async def get_db_settings() -> DbSettingsOut:
    return await settings_db_service.get()


@router.put(
    "",
    response_model=DbSettingsOut,
    summary="保存并切换数据库",
    description=(
        "校验连通性后写入 runtime-db.json 并热切换。"
        "SQLite 会自动建表；Postgres 仅切换连接，需再调用「初始化表结构」。"
    ),
)
async def put_db_settings(payload: DbSettingsUpdate) -> DbSettingsOut:
    try:
        return await settings_db_service.update(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"切换失败：{exc}") from exc


@router.post(
    "/test",
    response_model=DbTestOut,
    summary="测试数据库连通性",
    description="只试连，不切换、不建表、不落盘。",
)
async def test_db_settings(payload: DbTestRequest) -> DbTestOut:
    return await settings_db_service.test(payload)


@router.post(
    "/init",
    response_model=DbInitOut,
    summary="初始化 / 对齐表结构",
    description=(
        "对当前已连接数据库执行 create_all 与轻量列迁移，并写入默认 ai_settings。"
        "个人版 SQLite 启动时会自动执行；Postgres 建议在切换连接后由用户点击触发。"
    ),
)
async def init_db_schema() -> DbInitOut:
    try:
        return await settings_db_service.initialize_schema()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"初始化失败：{exc}") from exc
