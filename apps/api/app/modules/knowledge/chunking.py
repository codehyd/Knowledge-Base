"""正文切片：约 500 字，重叠 80。"""

from __future__ import annotations

CHUNK_SIZE = 500
CHUNK_OVERLAP = 80


def split_text(text: str, *, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    raw = (text or "").strip()
    if not raw:
        return []
    if size <= 0:
        return [raw]
    overlap = max(0, min(overlap, size - 1))

    chunks: list[str] = []
    start = 0
    n = len(raw)
    while start < n:
        end = min(n, start + size)
        piece = raw[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= n:
            break
        start = max(0, end - overlap)
        if start >= end:
            start = end
    return chunks
