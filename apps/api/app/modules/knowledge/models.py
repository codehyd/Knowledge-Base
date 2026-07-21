from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import mapped_column

from app.core.database import Base


class Entry(Base):
    """知识条目。喂养入库后再写入；空库时计数为 0。"""

    __tablename__ = "entries"

    # 不使用 Mapped[T] 注解：兼容本机 Python 3.14 + 当前 SQLAlchemy
    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    title = mapped_column(String(500), default="")
    summary = mapped_column(Text, default="")
    source_id = mapped_column(Integer, nullable=True, index=True)
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())


class Category(Base):
    __tablename__ = "categories"

    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    name = mapped_column(String(100), unique=True, index=True)
