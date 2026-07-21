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

router = APIRouter(prefix="/settings/ai", tags=["settings-ai"])


@router.get("/providers", response_model=ProvidersOut)
async def get_providers() -> ProvidersOut:
    return ProvidersOut(providers=settings_ai_service.providers_catalog())


@router.get("", response_model=AiSettingsOut)
async def get_ai_settings(db: AsyncSession = Depends(get_db)) -> AiSettingsOut:
    return await settings_ai_service.get(db)


@router.put("", response_model=AiSettingsOut)
async def put_ai_settings(
    payload: AiSettingsUpdate,
    db: AsyncSession = Depends(get_db),
) -> AiSettingsOut:
    return await settings_ai_service.update(db, payload)


@router.post("/test", response_model=AiTestOut)
async def test_ai_settings(db: AsyncSession = Depends(get_db)) -> AiTestOut:
    return await settings_ai_service.test_connection(db)
