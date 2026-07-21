from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import mapped_column

from app.core.database import Base


class AiSettings(Base):
    """全局 AI 配置（自用单用户：固定 id=1）。"""

    __tablename__ = "ai_settings"

    id = mapped_column(Integer, primary_key=True)
    provider = mapped_column(String(100), default="deepseek")
    base_url = mapped_column(String(500), default="https://api.deepseek.com/v1")
    api_key = mapped_column(Text, default="")
    chat_model = mapped_column(String(200), default="deepseek-v4-flash")
    embed_model = mapped_column(String(200), default="deepseek-v4-flash")
    updated_at = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
