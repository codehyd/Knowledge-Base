from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import mapped_column

from app.core.database import Base


class ChatSession(Base):
    """对话会话（仅持久化展示，不参与多轮 LLM 上下文）。"""

    __tablename__ = "chat_sessions"

    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    title = mapped_column(String(120), default="新对话")
    category_id = mapped_column(Integer, nullable=True, index=True)
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ChatMessage(Base):
    """会话内消息。"""

    __tablename__ = "chat_messages"

    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id = mapped_column(
        Integer, ForeignKey("chat_sessions.id", ondelete="CASCADE"), index=True
    )
    role = mapped_column(String(20), default="user")  # user | assistant
    content = mapped_column(Text, default="")
    refused = mapped_column(Boolean, default=False)
    citations_json = mapped_column(Text, default="")
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())
