from fastapi import APIRouter, HTTPException

from app.modules.settings_db.schemas import (
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
    description="连接配置保存在 data/runtime-db.json（不在业务库内）。密码字段脱敏。",
)
async def get_db_settings() -> DbSettingsOut:
    return await settings_db_service.get()


@router.put(
    "",
    response_model=DbSettingsOut,
    summary="保存并切换数据库",
    description="校验连通性后写入 runtime-db.json，并热切换当前引擎；失败则保持原连接。",
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
    description="只试连，不切换、不落盘。Postgres 连接串留空时使用已保存值。",
)
async def test_db_settings(payload: DbTestRequest) -> DbTestOut:
    return await settings_db_service.test(payload)
