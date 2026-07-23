"""Gutendex（Project Gutenberg）搜索与文件下载。"""

from __future__ import annotations

import re
from typing import Any

import httpx
from fastapi import HTTPException

from app.modules.open_books.providers.base import USER_AGENT
from app.modules.open_books.schemas import OpenBookItem, OpenBookSourceInfo

GUTENDEX = "https://gutendex.com/books"


class GutenbergProvider:
    info = OpenBookSourceInfo(
        id="gutenberg",
        name="Gutenberg",
        description="搜索英文书名或作者，如 Pride and Prejudice、Shakespeare。",
        languages=["en"],
    )

    async def search(self, query: str, *, page: int = 1) -> tuple[list[OpenBookItem], int]:
        q = (query or "").strip()
        if not q:
            raise HTTPException(status_code=400, detail="请输入书名或作者关键词")
        if len(q) > 200:
            raise HTTPException(status_code=400, detail="关键词过长")

        params = {"search": q, "page": max(1, page)}
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(25.0, connect=8.0),
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        ) as client:
            try:
                res = await client.get(GUTENDEX, params=params)
                res.raise_for_status()
            except httpx.HTTPError as exc:
                raise HTTPException(status_code=502, detail=f"Gutenberg 搜索失败：{exc}") from exc
            data = res.json()

        results = data.get("results") or []
        total = int(data.get("count") or len(results))
        items = [_to_item(b) for b in results if b.get("id")]
        items.sort(key=lambda x: (not x.has_epub and not x.has_text, -x.download_count))
        return items, total

    async def fetch(self, book_id: str) -> tuple[bytes, str, str]:
        try:
            bid = int(str(book_id).strip())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="无效的 Gutenberg 书籍 ID") from exc

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0),
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        ) as client:
            try:
                meta = await client.get(f"{GUTENDEX}/{bid}")
                meta.raise_for_status()
            except httpx.HTTPError as exc:
                raise HTTPException(status_code=502, detail=f"获取书籍信息失败：{exc}") from exc
            book = meta.json()
            item = _to_item(book)
            candidates = _pick_download_candidates(book.get("formats") or {})
            if not candidates:
                raise HTTPException(status_code=404, detail="该书暂无可用的 EPUB/TXT 下载链接")

            last_err: Exception | None = None
            for url, suffix in candidates:
                try:
                    file_res = await client.get(url)
                    file_res.raise_for_status()
                    data = file_res.content
                    if not data:
                        raise ValueError("空文件")
                    if len(data) > 40 * 1024 * 1024:
                        raise ValueError("文件过大，尝试下一格式")
                    safe_title = _safe_filename(item.title) or f"gutenberg-{bid}"
                    return data, f"{safe_title}{suffix}", item.title
                except Exception as exc:  # noqa: BLE001
                    last_err = exc
                    continue

        raise HTTPException(status_code=502, detail=f"下载电子书失败：{last_err}")


def _authors(raw: list[dict[str, Any]] | None) -> list[str]:
    names: list[str] = []
    for a in raw or []:
        name = str(a.get("name") or "").strip()
        if name:
            names.append(name)
    return names


def _pick_download_candidates(formats: dict[str, str] | None) -> list[tuple[str, str]]:
    formats = formats or {}
    epub_plain: list[str] = []
    epub_any: list[str] = []
    text_utf8: list[str] = []
    text_any: list[str] = []
    for key, url in formats.items():
        k = key.lower()
        u = str(url)
        if "application/epub" in k or ("epub" in k and "zip" in k):
            if "kindle" in k:
                continue
            if "noimages" in u.lower() or "epub3.epub" in u.lower():
                epub_plain.append(u)
            else:
                epub_any.append(u)
        elif k.startswith("text/plain") and "utf-8" in k:
            text_utf8.append(u)
        elif k.startswith("text/plain"):
            text_any.append(u)

    out: list[tuple[str, str]] = []
    for u in epub_plain:
        out.append((u, ".epub"))
    for u in epub_any:
        out.append((u, ".epub"))
    for u in text_utf8:
        out.append((u, ".txt"))
    for u in text_any:
        out.append((u, ".txt"))
    seen: set[str] = set()
    uniq: list[tuple[str, str]] = []
    for u, suf in out:
        if u in seen:
            continue
        seen.add(u)
        uniq.append((u, suf))
    return uniq


def _to_item(book: dict[str, Any]) -> OpenBookItem:
    bid = int(book.get("id") or 0)
    _epub, _text, has_epub, has_text = _pick_formats(book.get("formats") or {})
    cover = ""
    formats = book.get("formats") or {}
    for key, url in formats.items():
        if "image/jpeg" in key.lower() or "cover" in str(url).lower():
            cover = url
            break
    return OpenBookItem(
        id=str(bid),
        title=str(book.get("title") or f"Gutenberg #{bid}").strip(),
        authors=_authors(book.get("authors")),
        languages=list(book.get("languages") or []),
        download_count=int(book.get("download_count") or 0),
        cover_url=cover,
        has_epub=has_epub,
        has_text=has_text,
        source="gutenberg",
        detail_url=f"https://www.gutenberg.org/ebooks/{bid}" if bid else "",
    )


def _pick_formats(formats: dict[str, str] | None) -> tuple[str | None, str | None, bool, bool]:
    cands = _pick_download_candidates(formats)
    epub = next((u for u, s in cands if s == ".epub"), None)
    text = next((u for u, s in cands if s == ".txt"), None)
    return epub, text, bool(epub), bool(text)


def _safe_filename(title: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", title).strip()[:80]
