"""中文维基文库：搜索 + 拉取纯文本（含子页面拼接）。"""

from __future__ import annotations

import re
from html import unescape
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from app.modules.open_books.providers.base import USER_AGENT
from app.modules.open_books.schemas import OpenBookItem, OpenBookSourceInfo

API = "https://zh.wikisource.org/w/api.php"
REST_PLAIN = "https://zh.wikisource.org/api/rest_v1/page/plain"
SITE = "https://zh.wikisource.org/wiki"
MAX_CHARS = 2_500_000
MAX_SUBPAGES = 120


class WikisourceZhProvider:
    info = OpenBookSourceInfo(
        id="wikisource_zh",
        name="维基文库",
        description="搜索维基文库中的开放文本，适合古籍与长篇；下载为纯文本。",
        languages=["zh"],
    )

    async def search(self, query: str, *, page: int = 1) -> tuple[list[OpenBookItem], int]:
        q = (query or "").strip()
        if not q:
            raise HTTPException(status_code=400, detail="请输入书名或作者关键词")
        if len(q) > 200:
            raise HTTPException(status_code=400, detail="关键词过长")

        # MediaWiki search 无稳定 offset 分页时用 srlimit + 本地切片近似
        limit = 20
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(35.0, connect=12.0),
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        ) as client:
            try:
                res = await client.get(
                    API,
                    params={
                        "action": "query",
                        "list": "search",
                        "srsearch": q,
                        "srnamespace": 0,
                        "srlimit": limit,
                        "srprop": "snippet|titlesnippet|size",
                        "format": "json",
                        "utf8": 1,
                    },
                )
                res.raise_for_status()
            except httpx.HTTPError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"维基文库搜索失败（网络或超时）：{exc}",
                ) from exc
            data = res.json()

        rows = data.get("query", {}).get("search") or []
        total = int(data.get("query", {}).get("searchinfo", {}).get("totalhits") or len(rows))
        items = [_to_item(r) for r in rows if r.get("pageid") and r.get("title")]
        # 简单分页
        start = (max(1, page) - 1) * limit
        return items[start : start + limit], total

    async def fetch(self, book_id: str) -> tuple[bytes, str, str]:
        """book_id 为 pageid 或页面标题。"""
        raw = (book_id or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="无效的维基文库条目")

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=12.0),
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True,
            ) as client:
                title = raw
                if raw.isdigit():
                    title = await _title_from_pageid(client, int(raw))

                text = await _fetch_plain_with_subpages(client, title)
                if len(text.strip()) < 80:
                    raise HTTPException(
                        status_code=404,
                        detail="该页面正文过短（可能是索引页且子页拉取失败），请换条目或本地上传",
                    )

                safe = re.sub(r'[\\/:*?"<>|]+', "_", title).strip()[:80] or "wikisource"
                data = text.encode("utf-8")
                return data, f"{safe}.txt", title
        except HTTPException:
            raise
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"下载失败：无法连接维基文库（{exc.__class__.__name__}）",
            ) from exc


def _strip_html(snippet: str) -> str:
    s = re.sub(r"<[^>]+>", "", snippet or "")
    return unescape(s).strip()


def _to_item(row: dict[str, Any]) -> OpenBookItem:
    pageid = int(row.get("pageid") or 0)
    title = str(row.get("title") or "").strip()
    return OpenBookItem(
        id=str(pageid or title),
        title=title,
        authors=[],
        languages=["zh"],
        download_count=0,
        cover_url="",
        has_epub=False,
        has_text=True,
        source="wikisource_zh",
        detail_url=f"{SITE}/{quote(title.replace(' ', '_'))}" if title else "",
        snippet=_strip_html(str(row.get("snippet") or "")),
    )


async def _title_from_pageid(client: httpx.AsyncClient, pageid: int) -> str:
    res = await client.get(
        API,
        params={
            "action": "query",
            "pageids": pageid,
            "format": "json",
            "utf8": 1,
        },
    )
    res.raise_for_status()
    pages = res.json().get("query", {}).get("pages") or {}
    page = pages.get(str(pageid)) or next(iter(pages.values()), None)
    title = str((page or {}).get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=404, detail="找不到该维基文库页面")
    return title


async def _fetch_plain(client: httpx.AsyncClient, title: str) -> str:
    # 1) REST plain
    try:
        r = await client.get(f"{REST_PLAIN}/{quote(title, safe='')}")
        if r.status_code == 200 and r.text.strip():
            return r.text
    except httpx.HTTPError:
        pass

    # 2) extracts
    r = await client.get(
        API,
        params={
            "action": "query",
            "prop": "extracts",
            "explaintext": 1,
            "exsectionformat": "plain",
            "titles": title,
            "format": "json",
            "utf8": 1,
        },
    )
    r.raise_for_status()
    pages = r.json().get("query", {}).get("pages") or {}
    page = next(iter(pages.values()), {})
    return str(page.get("extract") or "")


async def _list_subpages(client: httpx.AsyncClient, title: str) -> list[str]:
    prefix = f"{title}/"
    titles: list[str] = []
    apcontinue = None
    while len(titles) < MAX_SUBPAGES:
        params: dict[str, Any] = {
            "action": "query",
            "list": "allpages",
            "apprefix": prefix,
            "apnamespace": 0,
            "aplimit": 50,
            "format": "json",
            "utf8": 1,
        }
        if apcontinue:
            params["apcontinue"] = apcontinue
        r = await client.get(API, params=params)
        r.raise_for_status()
        data = r.json()
        for row in data.get("query", {}).get("allpages") or []:
            t = str(row.get("title") or "").strip()
            if t:
                titles.append(t)
        apcontinue = (data.get("continue") or {}).get("apcontinue")
        if not apcontinue:
            break
    return titles[:MAX_SUBPAGES]


async def _fetch_plain_with_subpages(client: httpx.AsyncClient, title: str) -> str:
    main = await _fetch_plain(client, title)
    parts = [f"《{title}》\n\n{main}".strip()]
    total = len(parts[0])

    if total >= 8000:
        # 主页面已有较长正文，直接用
        return parts[0][:MAX_CHARS]

    subpages = await _list_subpages(client, title)
    for sub in subpages:
        if total >= MAX_CHARS:
            break
        try:
            chunk = await _fetch_plain(client, sub)
        except httpx.HTTPError:
            continue
        if not chunk.strip():
            continue
        block = f"\n\n## {sub}\n\n{chunk.strip()}"
        parts.append(block)
        total += len(block)

    return "".join(parts)[:MAX_CHARS]
