from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
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
    # 视频文案：音轨语音转写（可与对话服务商分离）
    asr_mode = mapped_column(String(20), default="auto")  # auto|local|cloud|off
    asr_base_url = mapped_column(String(500), default="")
    asr_api_key = mapped_column(Text, default="")
    asr_model = mapped_column(String(200), default="")
    asr_local_model = mapped_column(String(50), default="base")
    # 用户明确授权后，才下载/缓存视频音轨到本机（跟读与无字幕转写）
    allow_local_audio = mapped_column(Boolean, default=False)
    # 输出 token 上限：主回答 / 知识点 AI 摘段。推理模型的思考过程也占用该额度，需给足
    chat_max_tokens = mapped_column(Integer, default=1200)
    quote_refine_max_tokens = mapped_column(Integer, default=8000)
    updated_at = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
