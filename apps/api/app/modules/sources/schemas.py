from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class SourceOut(BaseModel):
    id: int
    type: str
    title: str
    filename: str
    source_uri: str
    provenance: str = ""
    book_kind: str = ""
    status: str
    stage: str
    progress: float
    error_message: str
    char_count: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class SourceListOut(BaseModel):
    items: list[SourceOut]
    total: int


class PasteIn(BaseModel):
    title: str = Field(default="", max_length=500)
    content: str = Field(min_length=1)


class UrlIn(BaseModel):
    # 允许粘贴抖音等「复制分享」整段文案，后端会自动抽链
    url: str = Field(min_length=8, max_length=4000)


class TranscriptIn(BaseModel):
    content: str = Field(min_length=1)


class IngestOut(BaseModel):
    source_id: int
    entry_id: int
    title: str
    category: str = ""
    categories: list[str] = Field(default_factory=list)


class IngestReadyOut(BaseModel):
    ingested: list[IngestOut]
    skipped: int = 0
    failed: list[dict] = Field(default_factory=list)


class SourcePreviewOut(BaseModel):
    source_id: int
    title: str
    filename: str = ""
    status: str
    char_count: int
    text: str
    offset: int = 0
    limit: int = 0
    truncated: bool = False


class PreviewSearchHit(BaseModel):
    offset: int
    length: int
    snippet: str


class PreviewSearchOut(BaseModel):
    query: str
    total: int
    offset: int = 0
    limit: int = 0
    hits: list[PreviewSearchHit] = Field(default_factory=list)
