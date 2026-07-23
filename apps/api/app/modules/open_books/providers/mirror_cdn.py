"""镜像 CDN 拉取：动态目录缓存 + 分章下载。"""

from __future__ import annotations

import asyncio
import re
import time
from html import unescape
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from app.modules.open_books.providers.base import USER_AGENT

MAX_CHARS = 2_500_000
MAX_FILES = 400
CONCURRENCY = 8
DIR_CACHE_TTL_SEC = 6 * 60 * 60  # 6 小时
_CHAPTER_EXTS = (".txt", ".html", ".htm", ".md")

# 仓库里偶发的非古籍目录，不当书目展示（不是书单，只是噪声过滤）
_SKIP_DIRS = {"生活中的经济学", "语文语法手册", "阅读与写作及怎样写作"}

_dir_cache: dict[str, tuple[float, list[str]]] = {}


def cache_key(repo: str, ref: str) -> str:
    return f"{repo}@{ref}"


def invalidate_dir_cache(repo: str | None = None, ref: str | None = None) -> None:
    if repo and ref:
        _dir_cache.pop(cache_key(repo, ref), None)
    else:
        _dir_cache.clear()


async def list_mirror_dirs(*, repo: str, ref: str = "master", force: bool = False) -> list[str]:
    """列出镜像仓库顶层目录名（带进程内缓存）。"""
    key = cache_key(repo, ref)
    now = time.time()
    if not force and key in _dir_cache:
        ts, dirs = _dir_cache[key]
        if now - ts < DIR_CACHE_TTL_SEC:
            return list(dirs)

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(40.0, connect=15.0),
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
    ) as client:
        dirs = await _fetch_top_dirs(client, repo=repo, ref=ref)

    dirs = [d for d in dirs if d and d not in _SKIP_DIRS]
    _dir_cache[key] = (now, dirs)
    return list(dirs)


async def fetch_cdn_book(*, title: str, repo: str, ref: str, folder: str) -> tuple[bytes, str, str]:
    title = (title or folder or "book").strip()
    repo = repo.strip()
    ref = (ref or "master").strip()
    folder = folder.strip()
    if not repo or not folder:
        raise HTTPException(status_code=500, detail="镜像配置不完整")

    safe = re.sub(r'[\\/:*?"<>|]+', "_", title).strip()[:80] or "book"

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=15.0),
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        ) as client:
            names = await _list_chapter_files(client, repo=repo, ref=ref, folder=folder)
            if not names:
                raise HTTPException(status_code=404, detail=f"镜像目录为空：{folder}")

            sem = asyncio.Semaphore(CONCURRENCY)
            parts: list[str | None] = [None] * len(names)

            async def _one(idx: int, name: str) -> None:
                async with sem:
                    text = await _download_file(
                        client, repo=repo, ref=ref, folder=folder, name=name
                    )
                    if text.strip():
                        parts[idx] = f"## {name}\n\n{text.strip()}"

            await asyncio.gather(*[_one(i, n) for i, n in enumerate(names)])

            chunks = [p for p in parts if p]
            if not chunks:
                raise HTTPException(status_code=502, detail="镜像章节全部下载失败，请稍后重试")

            body = f"《{title}》\n\n" + "\n\n".join(chunks)
            body = body[:MAX_CHARS]
            return body.encode("utf-8"), f"{safe}.txt", title
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"下载失败：无法连接国内镜像（{exc.__class__.__name__}）",
        ) from exc


async def _fetch_top_dirs(client: httpx.AsyncClient, *, repo: str, ref: str) -> list[str]:
    # 1) jsDelivr package metadata
    try:
        r = await client.get(f"https://data.jsdelivr.com/v1/packages/gh/{repo}@{ref}")
        if r.status_code == 200:
            dirs = [
                str(n.get("name") or "")
                for n in (r.json().get("files") or [])
                if n.get("type") == "directory" and n.get("name")
            ]
            if dirs:
                return sorted(dirs)
    except httpx.HTTPError:
        pass

    # 2) GitHub Contents API（根目录）
    try:
        r = await client.get(
            f"https://api.github.com/repos/{repo}/contents/",
            params={"ref": ref},
        )
        if r.status_code == 200 and isinstance(r.json(), list):
            dirs = sorted(
                str(x.get("name") or "")
                for x in r.json()
                if x.get("type") == "dir" and x.get("name")
            )
            if dirs:
                return dirs
    except httpx.HTTPError:
        pass

    raise HTTPException(
        status_code=502,
        detail="无法读取镜像书目目录（网络或仓库不可达）。可稍后重试，或在设置中更换镜像仓库。",
    )


async def _list_chapter_files(
    client: httpx.AsyncClient, *, repo: str, ref: str, folder: str
) -> list[str]:
    try:
        r = await client.get(f"https://data.jsdelivr.com/v1/packages/gh/{repo}@{ref}")
        if r.status_code == 200:
            names = _walk_package_dir(r.json().get("files") or [], folder)
            if names:
                return names[:MAX_FILES]
    except httpx.HTTPError:
        pass

    try:
        enc = quote(folder)
        r = await client.get(f"https://cdn.jsdelivr.net/gh/{repo}@{ref}/{enc}/")
        if r.status_code == 200:
            links = re.findall(
                rf"/gh/{re.escape(repo)}@{re.escape(ref)}/{re.escape(folder)}/([^\"?]+)",
                r.text,
            )
            names = sorted({_basename(n) for n in links if _is_chapter_file(n)})
            if names:
                return names[:MAX_FILES]
    except httpx.HTTPError:
        pass

    try:
        r = await client.get(
            f"https://api.github.com/repos/{repo}/contents/{quote(folder)}",
            params={"ref": ref},
        )
        if r.status_code == 200 and isinstance(r.json(), list):
            names = sorted(
                str(x.get("name") or "")
                for x in r.json()
                if x.get("type") == "file" and _is_chapter_file(str(x.get("name") or ""))
            )
            if names:
                return names[:MAX_FILES]
    except httpx.HTTPError:
        pass

    raise HTTPException(status_code=502, detail="无法列出镜像章节目录，请检查网络后重试")


def _is_chapter_file(name: str) -> bool:
    lower = name.lower()
    return any(lower.endswith(ext) for ext in _CHAPTER_EXTS)


def _walk_package_dir(nodes: list[dict], folder: str) -> list[str]:
    for node in nodes:
        if node.get("type") == "directory" and str(node.get("name") or "") == folder:
            files = [
                str(f.get("name") or "")
                for f in (node.get("files") or [])
                if f.get("type") == "file" and _is_chapter_file(str(f.get("name") or ""))
            ]
            return sorted(files)
        if node.get("type") == "directory":
            found = _walk_package_dir(node.get("files") or [], folder)
            if found:
                return found
    return []


def _basename(name: str) -> str:
    return name.split("/")[-1].strip()


def _to_plain(name: str, raw: str) -> str:
    text = raw
    if text.startswith("\ufeff"):
        text = text[1:]
    lower = name.lower()
    if lower.endswith(".html") or lower.endswith(".htm"):
        text = unescape(re.sub(r"(?is)<script[^>]*>.*?</script>", "", text))
        text = re.sub(r"(?is)<style[^>]*>.*?</style>", "", text)
        text = re.sub(r"<[^>]+>", "\n", text)
        text = unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


async def _download_file(
    client: httpx.AsyncClient, *, repo: str, ref: str, folder: str, name: str
) -> str:
    path = f"{folder}/{name}"
    enc = quote(path, safe="/")
    candidates = [
        f"https://cdn.jsdelivr.net/gh/{repo}@{ref}/{enc}",
        f"https://raw.githubusercontent.com/{repo}/{ref}/{enc}",
    ]
    last_err: Exception | None = None
    for url in candidates:
        try:
            r = await client.get(url)
            if r.status_code == 200 and r.text.strip():
                return _to_plain(name, r.text)
        except httpx.HTTPError as exc:
            last_err = exc
            continue
    if last_err:
        raise last_err
    return ""
