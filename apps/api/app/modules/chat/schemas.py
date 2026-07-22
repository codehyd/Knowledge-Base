from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    category_id: int | None = None
    session_id: int | None = None


class ChatCitation(BaseModel):
    entry_id: int
    title: str = ""
    snippet: str = ""
    score: float = 0.0


class ChatOut(BaseModel):
    answer: str
    refused: bool = False
    citations: list[ChatCitation] = Field(default_factory=list)
    retrieval: str = "keyword"  # keyword | vector
    session_id: int | None = None


class ChatSessionCreate(BaseModel):
    category_id: int | None = None
    title: str = Field(default="新对话", max_length=120)


class ChatSessionOut(BaseModel):
    id: int
    title: str
    category_id: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ChatSessionListOut(BaseModel):
    items: list[ChatSessionOut]


class ChatMessageOut(BaseModel):
    id: int
    session_id: int
    role: str
    content: str
    refused: bool = False
    citations: list[ChatCitation] = Field(default_factory=list)
    created_at: Optional[datetime] = None


class ChatMessageListOut(BaseModel):
    items: list[ChatMessageOut]
