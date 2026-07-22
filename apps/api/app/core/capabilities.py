"""全局数据库能力探测（如 pgvector）。"""

from __future__ import annotations

_vector_enabled: bool = False


def set_vector_enabled(value: bool) -> None:
    global _vector_enabled
    _vector_enabled = bool(value)


def is_vector_enabled() -> bool:
    return _vector_enabled
