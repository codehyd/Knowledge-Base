from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.settings_ai.schemas import (
    AiSettingsOut,
    AiSettingsUpdate,
    AiTestOut,
    ProvidersOut,
)
from app.modules.settings_ai.service import settings_ai_service

router = APIRouter(prefix="/settings/ai", tags=["模型配置"])


@router.get(
    "/providers",
    response_model=ProvidersOut,
    summary="可选服务商与模型目录",
)
async def get_providers() -> ProvidersOut:
    return ProvidersOut(providers=settings_ai_service.providers_catalog())


@router.get(
    "",
    response_model=AiSettingsOut,
    summary="读取当前 AI 配置",
    description="API Key 仅返回脱敏值。",
)
async def get_ai_settings(db: AsyncSession = Depends(get_db)) -> AiSettingsOut:
    return await settings_ai_service.get(db)


@router.put(
    "",
    response_model=AiSettingsOut,
    summary="保存 AI 配置",
    description="写入 Provider、Base URL、模型名；Key 留空表示不修改。",
)
async def put_ai_settings(
    payload: AiSettingsUpdate,
    db: AsyncSession = Depends(get_db),
) -> AiSettingsOut:
    return await settings_ai_service.update(db, payload)


@router.post(
    "/test",
    response_model=AiTestOut,
    summary="测试模型连通性",
    description="使用当前已保存配置发起最小请求，校验 Key 与 Base URL。",
)
async def test_ai_settings(db: AsyncSession = Depends(get_db)) -> AiTestOut:
    return await settings_ai_service.test_connection(db)
