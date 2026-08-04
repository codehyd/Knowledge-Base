"""Obsidian 风格双链：[[target]] / [[target|alias]] / [[note#heading]]."""

from __future__ import annotations

import re
from dataclasses import dataclass

# [[…]] 内允许 #（标题锚点）与 |alias；不跨行
_WIKILINK_RE = re.compile(r"\[\[([^\]\n]+?)\]\]")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


@dataclass(frozen=True)
class WikiLinkRef:
    raw: str
    target: str
    alias: str | None = None
    note: str = ""
    heading: str | None = None


def split_note_heading(target: str) -> tuple[str, str | None]:
    """拆成笔记目标与标题锚点。[[笔记#一级#二级]] → note, '一级#二级'。"""
    t = (target or "").strip().replace("\\", "/")
    if "|" in t:
        t = t.split("|", 1)[0].strip()
    if "#" not in t:
        return t, None
    note, _, heading = t.partition("#")
    note = note.strip()
    heading = heading.strip() or None
    return note, heading


def extract_markdown_headings(text: str) -> list[dict[str, str | int]]:
    """抽取 ATX 标题：[{level, text}, …]（保序）。"""
    out: list[dict[str, str | int]] = []
    for m in _HEADING_RE.finditer(text or ""):
        level = len(m.group(1))
        title = (m.group(2) or "").strip()
        if not title:
            continue
        out.append({"level": level, "text": title})
    return out


def extract_wikilinks(text: str) -> list[WikiLinkRef]:
    """从 Markdown 正文提取双链（按出现顺序，去重保留首次）。"""
    seen: set[str] = set()
    out: list[WikiLinkRef] = []
    for m in _WIKILINK_RE.finditer(text or ""):
        inner = (m.group(1) or "").strip()
        if not inner:
            continue
        alias: str | None = None
        body = inner
        if "|" in inner:
            body, alias_part = inner.split("|", 1)
            body = body.strip()
            alias = alias_part.strip() or None
        note, heading = split_note_heading(body)
        if not note and not heading:
            continue
        # 图谱/去重用完整目标（含 #）
        target = body.strip().replace("\\", "/")
        key = target.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(
            WikiLinkRef(
                raw=m.group(0),
                target=target,
                alias=alias,
                note=note,
                heading=heading,
            )
        )
    return out


def normalize_link_target(target: str) -> str:
    """规范化链接目标：去掉标题锚点、.md、首尾斜杠。"""
    note, _ = split_note_heading(target)
    t = (note or "").strip().replace("\\", "/").lstrip("/")
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
    """把链接目标解析为节点 id（仅笔记部分，忽略 #标题）。

    匹配顺序：完整相对路径 → 文件名（stem）→ 标题（大小写不敏感）。
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
