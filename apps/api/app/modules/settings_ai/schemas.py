from typing import Any, Optional

from pydantic import BaseModel, Field


class AiSettingsOut(BaseModel):
    provider: str
    base_url: str
    api_key_masked: str
    chat_model: str
    embed_model: str
    configured: bool
    asr_mode: str = "auto"
    asr_base_url: str = ""
    asr_api_key_masked: str = ""
    asr_model: str = ""
    asr_local_model: str = "base"
    asr_cloud_configured: bool = False


class AiSettingsUpdate(BaseModel):
    provider: str = Field(default="deepseek", min_length=1)
    base_url: str = Field(min_length=1)
    api_key: Optional[str] = None
    chat_model: str = Field(min_length=1)
    embed_model: str = Field(min_length=1)
    asr_mode: Optional[str] = None
    asr_base_url: Optional[str] = None
    asr_api_key: Optional[str] = None
    asr_model: Optional[str] = None
    asr_local_model: Optional[str] = None


class AiTestOut(BaseModel):
    ok: bool
    latency_ms: Optional[int] = None
    message: str = ""


class ProvidersOut(BaseModel):
    providers: list[dict[str, Any]]
