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
    # 原文绝对字符偏移；-1 表示未知，前端可回退搜索
    char_offset: int = -1
    # 适合精确高亮的短句（尽量来自原文连续行，避免换行被压空格）
    highlight_query: str = ""
    # 对话预笔记 id；点击出处时优先跳到该高亮，而不是乱搜关键词
    annotation_id: int | None = None
    # 知识点短标题（分组展开后展示）
    point_label: str = ""


class ChatOut(BaseModel):
    answer: str
    refused: bool = False
    # ok=可信作答；suspect=库内有据但存疑；conflict=库内材料明显有问题
    trust: str = "ok"
    trust_note: str = ""
    citations: list[ChatCitation] = Field(default_factory=list)
    retrieval: str = "keyword"  # keyword | vector
    session_id: int | None = None
    # done=已完成；pending=已受理，后台生成中（切页可轮询消息）
    status: str = "done"
    pending_message_id: int | None = None


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
    trust: str = "ok"
    trust_note: str = ""
    status: str = "done"  # done | pending | error
    # pending 阶段：accepted | retrieving | generating | citing
    progress: str = ""
    citations: list[ChatCitation] = Field(default_factory=list)
    created_at: Optional[datetime] = None


class ChatMessageListOut(BaseModel):
    items: list[ChatMessageOut]
