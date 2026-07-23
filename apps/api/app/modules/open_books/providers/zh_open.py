"""中文公版：动态镜像目录搜索 + 本地短篇 + 未命中回退维基文库。"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException
import zhconv

from app.modules.open_books.providers.mirror_cdn import fetch_cdn_book, list_mirror_dirs
from app.modules.open_books.providers.wikisource_zh import WikisourceZhProvider
from app.modules.open_books.schemas import OpenBookItem, OpenBookSourceInfo
from app.modules.open_books.settings_store import resolve_mirror_repo

_TEXTS = Path(__file__).resolve().parent.parent / "data" / "texts"
_LOCAL_PREFIX = "local:"
_MIRROR_PREFIX = "mirror:"


def _variants(text: str) -> set[str]:
    raw = (text or "").strip()
    if not raw:
        return set()
    out = {raw, raw.lower()}
    try:
        out.add(zhconv.convert(raw, "zh-hans"))
        out.add(zhconv.convert(raw, "zh-hant"))
        out.add(zhconv.convert(raw, "zh-hans").lower())
        out.add(zhconv.convert(raw, "zh-hant").lower())
    except Exception:  # noqa: BLE001
        pass
    return {x for x in out if x}


def _match(query: str, haystack: str) -> bool:
    q = (query or "").strip()
    if not q:
        return False
    h_vars = _variants(haystack)
    h_blob = " ".join(h_vars).lower()
    for v in _variants(q):
        if v.lower() in h_blob or any(v.lower() in x.lower() for x in h_vars):
            return True
    # 分词粗匹配
    for tok in q.replace("　", " ").split():
        if not tok:
            continue
        for v in _variants(tok):
            if v.lower() in h_blob:
                return True
    return False


def _local_title(path: Path) -> str:
    try:
        head = path.read_text(encoding="utf-8")[:400]
    except OSError:
        return path.stem
    for line in head.splitlines():
        s = line.strip().lstrip("\ufeff")
        if not s:
            continue
        if s.startswith("#"):
            s = s.lstrip("#").strip()
        m = re.match(r"^[《【\[](.+?)[》】\]]$", s)
        if m and 1 < len(m.group(1)) < 40:
            return m.group(1).strip()
        if 1 < len(s) < 40 and not s.startswith("道可道"):
            # 首行短标题；跳过正文开篇
            if re.search(r"[\u4e00-\u9fff]", s):
                return s
        break
    return path.stem


class ZhOpenProvider:
    info = OpenBookSourceInfo(
        id="zh_open",
        name="中文公版",
        description="输入中文书名搜索，如红楼梦、论语；简繁均可。",
        languages=["zh"],
    )

    def __init__(self) -> None:
        self._wiki = WikisourceZhProvider()

    async def search(self, query: str, *, page: int = 1) -> tuple[list[OpenBookItem], int]:
        q = (query or "").strip()
        if not q:
            raise HTTPException(status_code=400, detail="请输入书名或作者关键词")
        if len(q) > 200:
            raise HTTPException(status_code=400, detail="关键词过长")

        repo, ref = resolve_mirror_repo()
        hits: list[OpenBookItem] = []

        # 1) 本地短篇（扫描 texts/，非 JSON 书单）
        if _TEXTS.is_dir():
            for path in sorted(_TEXTS.glob("*.txt")):
                title = _local_title(path)
                blob = f"{path.stem} {title}"
                if _match(q, blob):
                    hits.append(
                        OpenBookItem(
                            id=f"{_LOCAL_PREFIX}{path.stem}",
                            title=title,
                            authors=[],
                            languages=["zh"],
                            has_epub=False,
                            has_text=True,
                            source="zh_open",
                            detail_url="",
                            snippet="本地文本，可直接下载",
                        )
                    )

        # 2) 动态镜像目录
        try:
            dirs = await list_mirror_dirs(repo=repo, ref=ref)
        except HTTPException:
            dirs = []

        for folder in dirs:
            if not _match(q, folder):
                continue
            hits.append(
                OpenBookItem(
                    id=f"{_MIRROR_PREFIX}{folder}",
                    title=folder,
                    authors=[],
                    languages=["zh"],
                    has_epub=False,
                    has_text=True,
                    source="zh_open",
                    detail_url=f"https://github.com/{repo}/tree/{ref}/{quote(folder)}",
                    snippet="国内镜像，可直接下载",
                )
            )

        # 3) 镜像/本地均未命中 → 维基文库外搜（失败则友好空结果，不整页报错）
        if not hits:
            try:
                wiki_items, wiki_total = await self._wiki.search(q, page=page)
            except HTTPException:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        "镜像与本地未找到匹配，且维基文库暂时不可达。"
                        "可换关键词，或稍后再试 / 本地上传。"
                    ),
                )
            for it in wiki_items:
                it.source = "zh_open"
                it.snippet = (it.snippet or "").strip()
                if it.snippet:
                    it.snippet = f"维基文库 · {it.snippet}"
                else:
                    it.snippet = "维基文库（镜像未收录）"
                it.id = f"wiki:{it.id}"
            return wiki_items, wiki_total

        total = len(hits)
        limit = 20
        start = (max(1, page) - 1) * limit
        return hits[start : start + limit], total

    async def fetch(self, book_id: str) -> tuple[bytes, str, str]:
        raw = (book_id or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="无效的书籍 id")

        if raw.startswith(_LOCAL_PREFIX):
            stem = raw[len(_LOCAL_PREFIX) :]
            path = _TEXTS / f"{stem}.txt"
            if not path.is_file():
                raise HTTPException(status_code=404, detail="本地文本不存在")
            text = path.read_text(encoding="utf-8").strip()
            title = _local_title(path)
            safe = re.sub(r'[\\/:*?"<>|]+', "_", title).strip()[:80] or stem
            return text.encode("utf-8"), f"{safe}.txt", title

        if raw.startswith(_MIRROR_PREFIX):
            folder = raw[len(_MIRROR_PREFIX) :]
            repo, ref = resolve_mirror_repo()
            return await fetch_cdn_book(title=folder, repo=repo, ref=ref, folder=folder)

        if raw.startswith("wiki:"):
            wiki_id = raw[len("wiki:") :]
            return await self._wiki.fetch(wiki_id)

        # 兼容：当作镜像文件夹名；失败再当维基
        repo, ref = resolve_mirror_repo()
        try:
            dirs = await list_mirror_dirs(repo=repo, ref=ref)
        except HTTPException:
            dirs = []
        if raw in dirs:
            return await fetch_cdn_book(title=raw, repo=repo, ref=ref, folder=raw)

        try:
            return await self._wiki.fetch(raw)
        except HTTPException as exc:
            raise HTTPException(
                status_code=exc.status_code,
                detail=f"下载失败：{exc.detail}",
            ) from exc
