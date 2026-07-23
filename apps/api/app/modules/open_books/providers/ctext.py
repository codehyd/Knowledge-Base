"""中国哲学书电子化计划（ctext.org）API。"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from app.modules.open_books.providers.base import USER_AGENT
from app.modules.open_books.schemas import OpenBookItem, OpenBookSourceInfo
from app.modules.open_books.settings_store import resolve_ctext_api_key

API = "https://api.ctext.org"
SITE = "https://ctext.org"
MAX_CHARS = 2_500_000
MAX_CHAPTERS = 200


class CtextProvider:
    info = OpenBookSourceInfo(
        id="ctext",
        name="中国哲书库",
        description=(
            "中国哲学书电子化计划（ctext.org）。可搜书名。"
            "全文下载需配置 ctext Key；未配置时可点提示前往设置。"
            "无密钥时也可改用「中文公版」。"
        ),
        languages=["zh"],
    )

    async def search(self, query: str, *, page: int = 1) -> tuple[list[OpenBookItem], int]:
        q = (query or "").strip()
        if not q:
            raise HTTPException(status_code=400, detail="请输入书名关键词")
        if len(q) > 100:
            raise HTTPException(status_code=400, detail="关键词过长")

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=12.0),
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        ) as client:
            try:
                res = await client.get(
                    f"{API}/searchtexts",
                    params={"title": q, "if": "zh"},
                )
                res.raise_for_status()
                data = res.json()
            except httpx.HTTPError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"ctext 搜索失败（网络或超时）：{exc}",
                ) from exc

        err = data.get("error") if isinstance(data, dict) else None
        if err:
            raise HTTPException(
                status_code=502,
                detail=_ctext_error_message(err),
            )

        books = data.get("books") or []
        has_key = bool(resolve_ctext_api_key())
        items = [_to_item(b, has_key=has_key) for b in books if b.get("urn") and b.get("title")]
        total = len(items)
        limit = 20
        start = (max(1, page) - 1) * limit
        return items[start : start + limit], total

    async def fetch(self, book_id: str) -> tuple[bytes, str, str]:
        urn = (book_id or "").strip()
        if not urn:
            raise HTTPException(status_code=400, detail="无效的 ctext 条目")
        if not urn.startswith("ctp:"):
            urn = f"ctp:{urn}"

        api_key = resolve_ctext_api_key()
        if not api_key:
            raise HTTPException(
                status_code=400,
                detail=(
                    "ctext 全文接口需要 API Key。"
                    "请到「设置 → 模型与 Key」配置，或改用「国内镜像 / 中文经典」书源下载。"
                ),
            )

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=12.0),
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True,
            ) as client:
                title, text = await _gettext_recursive(client, urn, api_key=api_key)
                if len(text.strip()) < 40:
                    raise HTTPException(status_code=404, detail="ctext 返回正文过短")
                safe = re.sub(r'[\\/:*?"<>|]+', "_", title).strip()[:80] or "ctext"
                return text.encode("utf-8"), f"{safe}.txt", title
        except HTTPException:
            raise
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"下载失败：无法连接 ctext（{exc.__class__.__name__}）",
            ) from exc


def _to_item(row: dict[str, Any], *, has_key: bool) -> OpenBookItem:
    urn = str(row.get("urn") or "").strip()
    title = str(row.get("title") or "").strip()
    slug = urn.removeprefix("ctp:") if urn.startswith("ctp:") else urn
    return OpenBookItem(
        id=urn,
        title=title,
        authors=[],
        languages=["zh"],
        has_epub=False,
        has_text=True,
        source="ctext",
        detail_url=f"{SITE}/{quote(slug)}/zh" if slug else SITE,
        snippet="" if has_key else "NEED_CTEXT_KEY",
    )


def _ctext_error_message(err: dict[str, Any]) -> str:
    code = str(err.get("code") or "")
    if code == "ERR_REQUEST_LIMIT":
        return "ctext 请求次数已达上限，请稍后再试或登录/配置 API Key"
    if code == "ERR_REQUIRES_AUTHENTICATION":
        return "ctext 需要认证：请配置 API Key，或改用国内镜像"
    if code == "ERR_INVALID_APIKEY":
        return "ctext API Key 无效或已过期"
    desc = re.sub(r"<[^>]+>", "", str(err.get("description") or "")).strip()
    return desc or f"ctext 错误：{code or '未知'}"


async def _api_get(
    client: httpx.AsyncClient, path: str, *, params: dict[str, Any]
) -> dict[str, Any]:
    res = await client.get(f"{API}/{path}", params=params)
    res.raise_for_status()
    data = res.json()
    if isinstance(data, dict) and data.get("error"):
        raise HTTPException(status_code=502, detail=_ctext_error_message(data["error"]))
    return data if isinstance(data, dict) else {}


async def _gettext_recursive(
    client: httpx.AsyncClient, urn: str, *, api_key: str, depth: int = 0
) -> tuple[str, str]:
    if depth > 6:
        return "", ""

    data = await _api_get(
        client,
        "gettext",
        params={"urn": urn, "if": "zh", "apikey": api_key},
    )
    title = str(data.get("title") or urn).strip()
    fulltext = data.get("fulltext")
    if isinstance(fulltext, list) and fulltext:
        body = "\n".join(str(p) for p in fulltext if str(p).strip())
        return title, body[:MAX_CHARS]

    subs = data.get("subsections") or []
    if not isinstance(subs, list) or not subs:
        return title, ""

    parts: list[str] = [f"《{title}》"]
    total = len(parts[0])
    for sub in subs[:MAX_CHAPTERS]:
        if total >= MAX_CHARS:
            break
        sub_urn = str(sub).strip()
        if not sub_urn:
            continue
        sub_title, sub_text = await _gettext_recursive(
            client, sub_urn, api_key=api_key, depth=depth + 1
        )
        if not sub_text.strip():
            continue
        block = f"\n\n## {sub_title or sub_urn}\n\n{sub_text.strip()}"
        parts.append(block)
        total += len(block)

    return title, "".join(parts)[:MAX_CHARS]
