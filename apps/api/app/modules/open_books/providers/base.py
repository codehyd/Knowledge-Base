from __future__ import annotations

from typing import Protocol

from app.modules.open_books.schemas import OpenBookItem, OpenBookSourceInfo

USER_AGENT = "KongkuKnowledgeBase/0.1 (personal; open-books)"


class BookProvider(Protocol):
    info: OpenBookSourceInfo

    async def search(self, query: str, *, page: int = 1) -> tuple[list[OpenBookItem], int]:
        ...

    async def fetch(self, book_id: str) -> tuple[bytes, str, str]:
        """返回 (文件内容, 文件名, 标题)。"""
        ...
