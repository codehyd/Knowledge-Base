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
    source_type: str = ""
    source_uri: str = ""
    in_vault: bool = False
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
    source_uri: str = ""
    in_vault: bool = False
    has_follow_along: bool = False

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

# 对话预笔记调色板：尽量让同书多条高亮一眼可区分
CHAT_ANCHOR_COLORS: tuple[str, ...] = (
    "#60a5fa",  # 蓝
    "#f47c5a",  # 橙
    "#34d399",  # 绿
    "#c084fc",  # 紫
    "#facc15",  # 黄
    "#fb7185",  # 玫红
    "#2a6f6a",  # 青
    "#f97316",  # 深橙
    "#818cf8",  # 靛
    "#a3e635",  # 黄绿
)


def normalize_ann_color(raw: str | None, *, default: str = "#facc15") -> str:
    """接受 #RRGGBB，或兼容旧版 yellow/teal/coral。"""
    c = (raw or default).strip()
    low = c.lower()
    if low in _LEGACY_COLOR_HEX:
        return _LEGACY_COLOR_HEX[low]
    if _HEX_COLOR_RE.match(c):
        return low
    raise ValueError("颜色请使用 #RRGGBB，或 yellow / teal / coral")


def pick_chat_anchor_color(used: set[str]) -> str:
    """从调色板里挑一个本条目尚未使用的颜色；用尽则循环。"""
    used_low = {u.lower() for u in used if u}
    for c in CHAT_ANCHOR_COLORS:
        if c.lower() not in used_low:
            return c
    # 全部占用时按数量取模，保证仍落在调色板
    return CHAT_ANCHOR_COLORS[len(used_low) % len(CHAT_ANCHOR_COLORS)]


def label_from_anchor_note(note: str | None) -> str:
    raw = (note or "").strip()
    if raw.startswith("对话引用｜"):
        return raw[len("对话引用｜") :].strip()
    if raw.startswith("对话引用"):
        return raw[len("对话引用") :].lstrip("｜| ").strip()
    return raw


def merge_point_labels(*labels: str, max_len: int = 48) -> str:
    """把多条知识点标题合成「A · B」；去重，并丢掉被更长标题包含的短词。"""
    parts: list[str] = []
    for raw in labels:
        text = re.sub(r"\s+", " ", (raw or "").strip())
        if not text:
            continue
        for p in re.split(r"[·|/／、,，;；+＋]+", text):
            p = p.strip()
            if len(p) < 2:
                continue
            parts.append(p)

    # 短的优先，便于后面用更长的覆盖掉被包含的短词
    parts.sort(key=lambda s: (len(s), s))
    kept: list[str] = []
    for p in parts:
        low = p.lower()
        # 已被保留项包含 → 跳过
        if any(low != k.lower() and low in k.lower() for k in kept):
            continue
        # 新项包含已保留的短项 → 替换掉短项
        kept = [k for k in kept if not (k.lower() != low and k.lower() in low)]
        if not any(k.lower() == low for k in kept):
            kept.append(p)

    # 展示时短标题在前，更易读
    kept.sort(key=lambda s: (len(s), s))
    if not kept:
        return ""
    out = " · ".join(kept)
    if len(out) <= max_len:
        return out
    # 超长则尽量多留几项
    trimmed: list[str] = []
    for p in kept:
        cand = " · ".join(trimmed + [p])
        if len(cand) > max_len:
            break
        trimmed.append(p)
    return " · ".join(trimmed) if trimmed else kept[0][:max_len]


def anchor_note_from_label(label: str | None) -> str:
    clean = re.sub(r"\s+", " ", (label or "").strip())[:48]
    return f"对话引用｜{clean}" if clean else "对话引用"


class AnnotationOut(BaseModel):
    id: int
    entry_id: int
    start_offset: int
    end_offset: int
    quote: str
    note: str = ""
    # note | chat_anchor
    kind: str = "note"
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
    kind: str = Field(default="note", max_length=20)


class AnnotationUpdate(BaseModel):
    note: Optional[str] = Field(default=None, max_length=2000)
    color: Optional[str] = Field(default=None, max_length=20)
    start_offset: Optional[int] = Field(default=None, ge=0)
    end_offset: Optional[int] = Field(default=None, ge=1)
    quote: Optional[str] = Field(default=None, max_length=2000)


class AnnotationPromoteIn(BaseModel):
    """将对话预笔记确认为正式笔记。"""
    note: str = Field(default="", max_length=2000)
    color: Optional[str] = Field(default=None, max_length=20)


class AnnotationExpandIn(BaseModel):
    """手动小步调整高亮区间。"""
    # 扩展：both | before | after；收缩：shrink_before | shrink_after
    direction: str = Field(default="after", max_length=16)
    # 每次扩/缩的句子（或转写文本的行）数
    sentences: int = Field(default=1, ge=1, le=10)


class ReindexOut(BaseModel):
    entries: int = 0
    chunks: int = 0
    mode: str = "missing"


class BookshelfItemOut(BaseModel):
    source_id: int
    entry_id: Optional[int] = None
    title: str
    filename: str = ""
    format: str = ""
    provenance: str = ""
    book_kind: str = "confirmed"
    status: str = ""
    char_count: int = 0
    created_at: Optional[datetime] = None


class BookshelfListOut(BaseModel):
    items: list[BookshelfItemOut]
    total: int = 0


class MediaItemOut(BaseModel):
    source_id: int
    entry_id: Optional[int] = None
    title: str
    source_uri: str = ""
    media_type: str = ""  # video_url | url
    status: str = ""
    char_count: int = 0
    has_follow_along: bool = False
    created_at: Optional[datetime] = None


class MediaListOut(BaseModel):
    items: list[MediaItemOut]
    total: int = 0
