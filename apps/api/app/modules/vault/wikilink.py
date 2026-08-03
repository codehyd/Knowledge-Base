"""Obsidian 风格双链：解析 [[target]] / [[target|alias]]。"""

from __future__ import annotations

import re
from dataclasses import dataclass

# [[target]] 或 [[target|alias]]；不跨行
_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+?)(?:\|([^\]]+))?\]\]")


@dataclass(frozen=True)
class WikiLinkRef:
    raw: str
    target: str
    alias: str | None = None


def extract_wikilinks(text: str) -> list[WikiLinkRef]:
    """从 Markdown 正文提取双链（按出现顺序，去重保留首次）。"""
    seen: set[str] = set()
    out: list[WikiLinkRef] = []
    for m in _WIKILINK_RE.finditer(text or ""):
        target = (m.group(1) or "").strip().replace("\\", "/")
        alias = (m.group(2) or "").strip() or None
        if not target:
            continue
        key = target.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(WikiLinkRef(raw=m.group(0), target=target, alias=alias))
    return out


def normalize_link_target(target: str) -> str:
    """规范化链接目标：去 .md、去首尾斜杠、统一分隔符。"""
    t = (target or "").strip().replace("\\", "/").lstrip("/")
    if t.lower().endswith(".md"):
        t = t[: -len(".md")]
    return t.strip()


def resolve_wikilink(
    target: str,
    *,
    by_path: dict[str, str],
    by_stem: dict[str, str],
    by_title: dict[str, str],
) -> str | None:
    """把链接目标解析为节点 id。

    匹配顺序：完整相对路径 → 文件名（stem）→ 标题（大小写不敏感）。
    by_* 的 value 为图谱节点 id。
    """
    norm = normalize_link_target(target)
    if not norm:
        return None

    candidates = [norm, f"{norm}.md"]
    for c in candidates:
        key = c.lower()
        if key in by_path:
            return by_path[key]

    stem = norm.rsplit("/", 1)[-1]
    hit = by_stem.get(stem.lower())
    if hit:
        return hit

    return by_title.get(norm.lower())


def source_type_to_kind(source_type: str | None) -> str:
    t = (source_type or "").strip().lower()
    if t == "note":
        return "note"
    if t == "ebook":
        return "book"
    if t in {"video_url", "video_file"}:
        return "video"
    if t == "url":
        return "url"
    return "other"
