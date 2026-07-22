from sqlalchemy import DateTime, Integer, String, Text, Float, func
from sqlalchemy.orm import mapped_column

from app.core.database import Base


class Source(Base):
    """喂养来源：电子书 / 笔记 / 链接。解析确认前都挂在此表。"""

    __tablename__ = "sources"

    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    # ebook | note | url | video_url
    type = mapped_column(String(50), index=True, default="note")
    title = mapped_column(String(500), default="")
    filename = mapped_column(String(500), default="")
    source_uri = mapped_column(String(2000), default="")  # 原始 URL（若有）
    # pending | extracting | processing | ready | failed | need_transcript | committed
    status = mapped_column(String(50), index=True, default="pending")
    stage = mapped_column(String(80), default="")  # 当前阶段文案/枚举
    progress = mapped_column(Float, default=0.0)
    error_message = mapped_column(Text, default="")
    storage_path = mapped_column(String(1000), default="")  # 相对 data 的原件路径
    text_path = mapped_column(String(1000), default="")  # 抽取后的正文路径
    char_count = mapped_column(Integer, default=0)
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
