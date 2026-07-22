"""正文预览内的关键字检索。"""

from __future__ import annotations

import re


def search_text_hits(
    text: str,
    query: str,
    *,
    offset: int = 0,
    limit: int = 100,
    snippet_radius: int = 36,
) -> tuple[list[dict], int]:
    """返回 (当前页 hits, 全文命中总数)。"""
    q = (query or "").strip()
    if not q or not text:
        return [], 0

    pattern = re.compile(re.escape(q), re.IGNORECASE)
    matches = list(pattern.finditer(text))
    total = len(matches)
    offset = max(0, offset)
    limit = max(1, limit)
    page = matches[offset : offset + limit]

    hits: list[dict] = []
    for match in page:
        start = match.start()
        end = match.end()
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
                "length": end - start,
                "snippet": snippet,
            }
        )
    return hits, total
