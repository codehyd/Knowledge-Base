from datetime import datetime
from typing import Optional
import re

from pydantic import BaseModel, Field


class CategoryOut(BaseModel):
    id: int
    name: str
    count: int = 0

    model_config = {"from_attributes": True}


class CategoryListOut(BaseModel):
    items: list[CategoryOut]
    total_entries: int = 0


class EntryListItem(BaseModel):
    id: int
    title: str
    summary: str
    source_id: Optional[int] = None
    categories: list[str] = Field(default_factory=list)
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class EntryListOut(BaseModel):
    items: list[EntryListItem]
    total: int
    page: int
    page_size: int


class EntryDetailOut(BaseModel):
    id: int
    title: str
    summary: str
    source_id: Optional[int] = None
    categories: list[str] = Field(default_factory=list)
    created_at: Optional[datetime] = None
    preview: str = ""
    preview_truncated: bool = False
    char_count: int = 0
    source_filename: str = ""
    source_type: str = ""

    model_config = {"from_attributes": True}


class EntryPreviewOut(BaseModel):
    entry_id: int
    source_id: Optional[int] = None
    title: str
    char_count: int
    text: str
    offset: int = 0
    limit: int = 0
    truncated: bool = False


_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_LEGACY_COLOR_HEX = {
    "yellow": "#facc15",
    "teal": "#2a6f6a",
    "coral": "#f47c5a",
}


def normalize_ann_color(raw: str | None, *, default: str = "#facc15") -> str:
    """接受 #RRGGBB，或兼容旧版 yellow/teal/coral。"""
    c = (raw or default).strip()
    low = c.lower()
    if low in _LEGACY_COLOR_HEX:
        return _LEGACY_COLOR_HEX[low]
    if _HEX_COLOR_RE.match(c):
        return low
    raise ValueError("颜色请使用 #RRGGBB，或 yellow / teal / coral")


class AnnotationOut(BaseModel):
    id: int
    entry_id: int
    start_offset: int
    end_offset: int
    quote: str
    note: str = ""
    color: str = "#facc15"
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class AnnotationListOut(BaseModel):
    items: list[AnnotationOut]


class AnnotationCreate(BaseModel):
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=2000)
    note: str = Field(default="", max_length=2000)
    color: str = Field(default="#facc15", max_length=20)


class AnnotationUpdate(BaseModel):
    note: Optional[str] = Field(default=None, max_length=2000)
    color: Optional[str] = Field(default=None, max_length=20)


class ReindexOut(BaseModel):
    entries: int = 0
    chunks: int = 0
    mode: str = "missing"
