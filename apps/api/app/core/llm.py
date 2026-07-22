"""统一 LLM / Embedding HTTP 调用（OpenAI 兼容）。"""

from __future__ import annotations

import json
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.settings_ai.service import settings_ai_service


class LlmNotConfigured(Exception):
    """未配置 API Key。"""


async def _creds(db: AsyncSession) -> dict[str, str]:
    row = await settings_ai_service._get_or_create(db)
    key = (row.api_key or "").strip()
    if not key:
        raise LlmNotConfigured("尚未配置 API Key，请先到设置页填写")
    return {
        "api_key": key,
        "base_url": (row.base_url or "").rstrip("/"),
        "chat_model": (row.chat_model or "").strip() or "deepseek-chat",
        "embed_model": (row.embed_model or "").strip() or row.chat_model or "deepseek-chat",
    }


async def chat_completion(
    db: AsyncSession,
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.2,
    max_tokens: int = 1200,
) -> str:
    creds = await _creds(db)
    payload = {
        "model": creds["chat_model"],
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {creds['api_key']}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        resp = await client.post(
            f"{creds['base_url']}/chat/completions",
            headers=headers,
            json=payload,
        )
    if resp.status_code >= 400:
        detail = (resp.text or "")[:300]
        raise RuntimeError(f"对话模型返回 {resp.status_code}" + (f"：{detail}" if detail else ""))
    data = resp.json()
    try:
        return str(data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("对话模型响应格式异常") from exc


async def embed_texts(db: AsyncSession, texts: list[str]) -> list[list[float]] | None:
    """调用 /embeddings；失败返回 None（触发关键词检索降级）。"""
    cleaned = [t for t in texts if (t or "").strip()]
    if not cleaned:
        return []
    try:
        creds = await _creds(db)
    except LlmNotConfigured:
        return None

    payload: dict[str, Any] = {
        "model": creds["embed_model"],
        "input": cleaned if len(cleaned) > 1 else cleaned[0],
    }
    headers = {"Authorization": f"Bearer {creds['api_key']}"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
            resp = await client.post(
                f"{creds['base_url']}/embeddings",
                headers=headers,
                json=payload,
            )
        if resp.status_code >= 400:
            return None
        data = resp.json()
        items = data.get("data") or []
        # OpenAI 风格：按 index 排序
        items = sorted(items, key=lambda x: int(x.get("index", 0)))
        vectors: list[list[float]] = []
        for item in items:
            emb = item.get("embedding")
            if not isinstance(emb, list) or not emb:
                return None
            vectors.append([float(x) for x in emb])
        if len(vectors) != len(cleaned):
            return None
        return vectors
    except Exception:
        return None


def dump_embedding(vec: list[float] | None) -> str:
    if not vec:
        return ""
    return json.dumps(vec, separators=(",", ":"))


def load_embedding(raw: str | None) -> list[float] | None:
    if not raw or not str(raw).strip():
        return None
    try:
        data = json.loads(raw)
        if isinstance(data, list) and data:
            return [float(x) for x in data]
    except Exception:
        return None
    return None


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / ((na**0.5) * (nb**0.5))
