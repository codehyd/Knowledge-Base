from typing import Any, Optional

from pydantic import BaseModel, Field


class AiSettingsOut(BaseModel):
    provider: str
    base_url: str
    api_key_masked: str
    chat_model: str
    embed_model: str
    configured: bool


class AiSettingsUpdate(BaseModel):
    provider: str = Field(default="deepseek", min_length=1)
    base_url: str = Field(min_length=1)
    api_key: Optional[str] = None
    chat_model: str = Field(min_length=1)
    embed_model: str = Field(min_length=1)


class AiTestOut(BaseModel):
    ok: bool
    latency_ms: Optional[int] = None
    message: str = ""


class ProvidersOut(BaseModel):
    providers: list[dict[str, Any]]
