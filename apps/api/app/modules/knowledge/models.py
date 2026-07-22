from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
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
    # 去重指纹：规范化标题 / 正文 hash
    title_key = mapped_column(String(200), default="", index=True)
    content_hash = mapped_column(String(64), default="", index=True)
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())


class Category(Base):
    __tablename__ = "categories"

    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    name = mapped_column(String(100), unique=True, index=True)


class EntryCategory(Base):
    """条目与分类多对多。"""

    __tablename__ = "entry_categories"
    __table_args__ = (UniqueConstraint("entry_id", "category_id", name="uq_entry_category"),)

    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_id = mapped_column(Integer, ForeignKey("entries.id", ondelete="CASCADE"), index=True)
    category_id = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="CASCADE"), index=True
    )


class EntryAnnotation(Base):
    """条目正文划选高亮 / 批注。"""

    __tablename__ = "entry_annotations"

    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_id = mapped_column(Integer, ForeignKey("entries.id", ondelete="CASCADE"), index=True)
    start_offset = mapped_column(Integer, default=0)
    end_offset = mapped_column(Integer, default=0)
    quote = mapped_column(Text, default="")
    note = mapped_column(Text, default="")
    # yellow | teal | coral | #rrggbb
    color = mapped_column(String(20), default="#facc15")
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Chunk(Base):
    """条目正文切片，供对话检索（RAG）。embedding 以 JSON 数组存储，兼容无 pgvector。"""

    __tablename__ = "chunks"

    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_id = mapped_column(Integer, ForeignKey("entries.id", ondelete="CASCADE"), index=True)
    ord = mapped_column(Integer, default=0)
    text = mapped_column(Text, default="")
    char_count = mapped_column(Integer, default=0)
    # JSON list[float]；无向量时为空串
    embedding = mapped_column(Text, default="")
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())
