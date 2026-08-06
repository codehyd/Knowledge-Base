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
    vault_path: str = ""
    collection_title: str = ""
    episode_no: int = 0
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


class UrlProbeIn(BaseModel):
    url: str = Field(min_length=8, max_length=4000)


class UrlProbeEpisode(BaseModel):
    episode_no: int
    title: str = ""


class UrlProbeOut(BaseModel):
    is_playlist: bool = False
    collection_title: str = ""
    total: int = 0
    # 分集清单（供前端选集多选）；flat 探测时 title 可能为空
    entries: list[UrlProbeEpisode] = Field(default_factory=list)


class UrlBatchIn(BaseModel):
    """合集/分P 批量投递。

    - import_all=True：导入全部集数
    - episode_nos：指定集号（可多选）
    - limit：仅前 N 集（兼容旧客户端）
    三者必须有其一，避免漏传参数时误导入全量。
    """

    url: str = Field(min_length=8, max_length=4000)
    import_all: bool = False
    limit: Optional[int] = Field(default=None, ge=1, le=500)
    episode_nos: Optional[list[int]] = Field(default=None, max_length=500)


class UrlBatchOut(BaseModel):
    collection_title: str = ""
    total: int = 0
    created: int = 0
    skipped: int = 0
    source_ids: list[int] = Field(default_factory=list)


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


class SourceContentOut(BaseModel):
    source_id: int
    title: str
    content: str
    format: str = "markdown"
    status: str = ""
    editable: bool = True


class SourceContentIn(BaseModel):
    title: str = Field(default="", max_length=500)
    content: str = Field(min_length=1)


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


class TimedCueOut(BaseModel):
    start: float
    end: float
    text: str


class SourceCuesOut(BaseModel):
    source_id: int
    title: str = ""
    has_media: bool = False
    media_url: str = ""
    cues: list[TimedCueOut] = Field(default_factory=list)
