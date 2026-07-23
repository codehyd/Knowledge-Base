from __future__ import annotations

from app.modules.open_books.providers.ctext import CtextProvider
from app.modules.open_books.providers.gutenberg import GutenbergProvider
from app.modules.open_books.providers.wikisource_zh import WikisourceZhProvider
from app.modules.open_books.providers.zh_open import ZhOpenProvider
from app.modules.open_books.schemas import OpenBookSourceInfo

_PROVIDERS = {
    "zh_open": ZhOpenProvider(),
    "ctext": CtextProvider(),
    "wikisource_zh": WikisourceZhProvider(),
    "gutenberg": GutenbergProvider(),
}

# 兼容旧书源 id
_ALIASES = {
    "chinese_classics": "zh_open",
    "cdn_mirror": "zh_open",
}

DEFAULT_SOURCE = "zh_open"


def list_sources() -> list[OpenBookSourceInfo]:
    order = ["zh_open", "ctext", "wikisource_zh", "gutenberg"]
    return [_PROVIDERS[k].info for k in order if k in _PROVIDERS]


def get_provider(source: str):
    key = (source or DEFAULT_SOURCE).strip() or DEFAULT_SOURCE
    key = _ALIASES.get(key, key)
    provider = _PROVIDERS.get(key)
    if not provider:
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail=f"未知书源：{source}")
    return provider
