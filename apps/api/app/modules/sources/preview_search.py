"""正文预览内的关键字检索。"""

from __future__ import annotations

import re


def _compile_query_pattern(query: str) -> re.Pattern[str] | None:
    """把查询编成可跨空白匹配的模式（适配视频转写换行被压成空格的引用）。"""
    q = (query or "").strip()
    if not q:
        return None
    parts = [p for p in re.split(r"\s+", q) if p]
    if not parts:
        return None
    if len(parts) == 1:
        return re.compile(re.escape(parts[0]), re.IGNORECASE)
    # 片段之间允许任意空白（含换行），也允许紧贴
    return re.compile(r"\s*".join(re.escape(p) for p in parts), re.IGNORECASE)


def _compact_matches(text: str, query: str) -> list[tuple[int, int]]:
    """忽略双方空白后匹配，并映射回原文偏移。"""
    q = re.sub(r"\s+", "", (query or "").strip())
    if len(q) < 4 or not text:
        return []

    compact_chars: list[str] = []
    compact_to_orig: list[int] = []
    for i, ch in enumerate(text):
        if ch.isspace():
            continue
        compact_chars.append(ch)
        compact_to_orig.append(i)
    compact = "".join(compact_chars)
    if not compact:
        return []

    pattern = re.compile(re.escape(q), re.IGNORECASE)
    out: list[tuple[int, int]] = []
    for m in pattern.finditer(compact):
        start_i = m.start()
        end_i = m.end() - 1
        if start_i >= len(compact_to_orig) or end_i >= len(compact_to_orig):
            continue
        out.append((compact_to_orig[start_i], compact_to_orig[end_i] + 1))
    return out


def locate_text_offset(haystack: str, needle: str) -> int:
    """在正文中定位 needle，找不到返回 -1。优先精确，再空白弹性。"""
    text = haystack or ""
    raw = (needle or "").strip()
    if not text or not raw:
        return -1

    idx = text.find(raw)
    if idx >= 0:
        return idx

    collapsed = re.sub(r"\s+", " ", raw).strip()
    hits, _ = search_text_hits(text, collapsed or raw, offset=0, limit=1)
    if hits:
        return int(hits[0]["offset"])

    for line in raw.splitlines():
        line = line.strip()
        if len(line) < 4:
            continue
        idx = text.find(line)
        if idx >= 0:
            return idx
        hits, _ = search_text_hits(text, line[:80], offset=0, limit=1)
        if hits:
            return int(hits[0]["offset"])

    parts = [p for p in re.split(r"\s+", collapsed or raw) if len(p) >= 4]
    parts.sort(key=len, reverse=True)
    for part in parts[:6]:
        idx = text.find(part)
        if idx >= 0:
            return idx
        hits, _ = search_text_hits(text, part[:80], offset=0, limit=1)
        if hits:
            return int(hits[0]["offset"])
    return -1


def highlight_needle_from_text(text: str, *, max_len: int = 40) -> str:
    """从原文取一段适合高亮搜索的连续短句（优先整行）。"""
    raw = (text or "").strip()
    if not raw:
        return ""
    for line in raw.splitlines():
        line = line.strip()
        if len(line) >= 4:
            return line[:max_len]
    collapsed = re.sub(r"\s+", "", raw)
    return collapsed[:max_len]


def search_text_hits(
    text: str,
    query: str,
    *,
    offset: int = 0,
    limit: int = 100,
    snippet_radius: int = 36,
) -> tuple[list[dict], int]:
    """返回 (当前页 hits, 全文命中总数)。支持跨换行/多空格匹配。"""
    q = (query or "").strip()
    if not q or not text:
        return [], 0

    spans: list[tuple[int, int]] = []
    pattern = _compile_query_pattern(q)
    if pattern is not None:
        for m in pattern.finditer(text):
            spans.append((m.start(), m.end()))

    if not spans:
        spans = _compact_matches(text, q)

    # 去重（按起点）
    seen: set[int] = set()
    uniq: list[tuple[int, int]] = []
    for start, end in spans:
        if start in seen:
            continue
        seen.add(start)
        uniq.append((start, max(start + 1, end)))
    spans = uniq

    total = len(spans)
    offset = max(0, offset)
    limit = max(1, limit)
    page = spans[offset : offset + limit]

    hits: list[dict] = []
    for start, end in page:
        left = max(0, start - snippet_radius)
        right = min(len(text), end + snippet_radius)
        snippet = text[left:right].replace("\n", " ")
        if left > 0:
            snippet = "…" + snippet
        if right < len(text):
            snippet = snippet + "…"
        hits.append(
            {
                "offset": start,
                "length": max(1, end - start),
                "snippet": snippet,
            }
        )
    return hits, total
