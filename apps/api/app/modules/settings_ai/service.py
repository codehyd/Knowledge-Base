import time
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.settings_ai.models import AiSettings
from app.modules.settings_ai.providers import infer_provider_id, list_providers
from app.modules.settings_ai.schemas import AiSettingsOut, AiSettingsUpdate, AiTestOut

SINGLETON_ID = 1


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "***"
    return f"{key[:3]}***{key[-4:]}"


class SettingsAiService:
    async def _get_or_create(self, db: AsyncSession) -> AiSettings:
        row = await db.get(AiSettings, SINGLETON_ID)
        if row:
            if not getattr(row, "provider", None):
                row.provider = infer_provider_id(row.base_url)
                await db.commit()
                await db.refresh(row)
            return row

        env = get_settings()
        row = AiSettings(
            id=SINGLETON_ID,
            provider=infer_provider_id(env.llm_base_url) or "deepseek",
            base_url=env.llm_base_url,
            api_key=env.llm_api_key,
            chat_model=env.llm_chat_model,
            embed_model=env.llm_embed_model,
            asr_mode="auto",
            asr_local_model="base",
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row

    async def is_configured(self, db: AsyncSession) -> bool:
        row = await self._get_or_create(db)
        return bool((row.api_key or "").strip())

    def _asr_out_fields(self, row: AiSettings) -> dict[str, Any]:
        asr_key = getattr(row, "asr_api_key", None) or ""
        return {
            "asr_mode": (getattr(row, "asr_mode", None) or "auto").strip() or "auto",
            "asr_base_url": (getattr(row, "asr_base_url", None) or "").strip(),
            "asr_api_key_masked": mask_key(asr_key),
            "asr_model": (getattr(row, "asr_model", None) or "").strip(),
            "asr_local_model": (getattr(row, "asr_local_model", None) or "base").strip()
            or "base",
            "asr_cloud_configured": bool(asr_key.strip()),
        }

    async def get(self, db: AsyncSession) -> AiSettingsOut:
        row = await self._get_or_create(db)
        provider = row.provider or infer_provider_id(row.base_url)
        return AiSettingsOut(
            provider=provider,
            base_url=row.base_url,
            api_key_masked=mask_key(row.api_key or ""),
            chat_model=row.chat_model,
            embed_model=row.embed_model,
            configured=bool((row.api_key or "").strip()),
            **self._asr_out_fields(row),
        )

    async def asr_config(self, db: AsyncSession) -> dict[str, str]:
        """供喂养流水线使用的转写配置。"""
        row = await self._get_or_create(db)
        return {
            "asr_mode": (getattr(row, "asr_mode", None) or "auto").strip() or "auto",
            "asr_base_url": (getattr(row, "asr_base_url", None) or "").strip(),
            "asr_api_key": (getattr(row, "asr_api_key", None) or "").strip(),
            "asr_model": (getattr(row, "asr_model", None) or "").strip(),
            "asr_local_model": (getattr(row, "asr_local_model", None) or "base").strip()
            or "base",
            "chat_base_url": (row.base_url or "").rstrip("/"),
            "chat_api_key": (row.api_key or "").strip(),
        }

    async def update(self, db: AsyncSession, payload: AiSettingsUpdate) -> AiSettingsOut:
        row = await self._get_or_create(db)
        row.provider = payload.provider
        row.base_url = payload.base_url.rstrip("/")
        row.chat_model = payload.chat_model
        row.embed_model = payload.embed_model
        if payload.api_key is not None and payload.api_key.strip():
            row.api_key = payload.api_key.strip()
        if payload.asr_mode is not None:
            mode = payload.asr_mode.strip().lower() or "auto"
            if mode not in {"auto", "local", "cloud", "off"}:
                mode = "auto"
            row.asr_mode = mode
        if payload.asr_base_url is not None:
            row.asr_base_url = payload.asr_base_url.strip().rstrip("/")
        if payload.asr_api_key is not None and payload.asr_api_key.strip():
            row.asr_api_key = payload.asr_api_key.strip()
        if payload.asr_model is not None:
            row.asr_model = payload.asr_model.strip()
        if payload.asr_local_model is not None:
            row.asr_local_model = payload.asr_local_model.strip() or "base"
        await db.commit()
        await db.refresh(row)
        return await self.get(db)

    async def test_connection(self, db: AsyncSession) -> AiTestOut:
        row = await self._get_or_create(db)
        if not (row.api_key or "").strip():
            return AiTestOut(ok=False, message="尚未配置 API Key，请先保存")

        base = row.base_url.rstrip("/")
        headers = {"Authorization": f"Bearer {row.api_key}"}
        started = time.perf_counter()
        # 用最小 chat 请求探测：部分厂商 /models 慢或不开放，会导致「卡住」感
        payload = {
            "model": row.chat_model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
            "stream": False,
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(12.0, connect=5.0)) as client:
                resp = await client.post(
                    f"{base}/chat/completions",
                    headers=headers,
                    json=payload,
                )
            latency = int((time.perf_counter() - started) * 1000)
            if resp.status_code >= 400:
                detail = (resp.text or "")[:200]
                return AiTestOut(
                    ok=False,
                    latency_ms=latency,
                    message=f"服务商返回 {resp.status_code}"
                    + (f"：{detail}" if detail else ""),
                )
            return AiTestOut(ok=True, latency_ms=latency, message="连接成功")
        except httpx.TimeoutException:
            return AiTestOut(ok=False, message="连接超时（12s），请检查 Base URL / 网络")
        except httpx.HTTPError as exc:
            return AiTestOut(ok=False, message=f"网络错误：{exc.__class__.__name__}")

    def providers_catalog(self) -> list[dict[str, Any]]:
        return list_providers()


settings_ai_service = SettingsAiService()
