"""入库时的去重指纹与分类标签推断。"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

import httpx

# 书名/正文里常见主题词 → 可检索分类（启发式兜底，有 Key 时优先走 LLM）
_KEYWORD_TAGS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"阿德勒|adler", re.I), "阿德勒"),
    (re.compile(r"心理|自我启发|自我成长|人格|潜意识"), "心理学"),
    (re.compile(r"哲学|哲思"), "哲学"),
    (re.compile(r"中医|方剂|经络|本草"), "中医"),
    (re.compile(r"益智|脑筋急转弯|谜题|推理题"), "益智"),
    (re.compile(r"理财|投资|财富|股票"), "理财"),
    (re.compile(r"管理|领导力|组织"), "管理"),
    (re.compile(r"历史|通史"), "历史"),
    (re.compile(r"科学|物理|化学|生物"), "科学"),
    (re.compile(r"编程|代码|软件|算法"), "技术"),
    (re.compile(r"教育|育儿|学习法"), "教育"),
    (re.compile(r"沟通|人际关系|社交"), "沟通"),
]

_FORMAT_NOISE = {
    "电子书",
    "ebook",
    "pdf",
    "epub",
    "txt",
    "笔记",
    "网页",
    "视频",
    "未分类",
    "材料",
    "文档",
}


def normalize_title_key(title: str) -> str:
    """用于判重的标题指纹：去空白、标点、扩展名。"""
    text = (title or "").strip().lower()
    text = re.sub(r"\.(pdf|epub|txt|md|markdown)$", "", text, flags=re.I)
    text = re.sub(r"[\s_\-–—·・.，,。:：;；!！?？\"'“”‘’（）()【】\[\]《》<>|/\\]+", "", text)
    return text[:200]


def content_fingerprint(text: str) -> str:
    """正文指纹：压缩空白后 SHA256。"""
    compact = re.sub(r"\s+", "", (text or "").strip())
    return hashlib.sha256(compact.encode("utf-8")).hexdigest()


def _clean_tag(name: str) -> str:
    name = re.sub(r"\s+", "", (name or "").strip())
    name = name.strip("#·-_/\\")
    if len(name) < 2 or len(name) > 20:
        return ""
    if name.lower() in _FORMAT_NOISE or name in _FORMAT_NOISE:
        return ""
    return name


def heuristic_tags(title: str, text_sample: str = "") -> list[str]:
    """无 Key 时：从书名片段 + 关键词映射推断标签。"""
    tags: list[str] = []
    seen: set[str] = set()

    def add(tag: str) -> None:
        cleaned = _clean_tag(tag)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            tags.append(cleaned)

    # 书名按常见分隔符拆成片段（被讨厌的勇气_自我启发之父_阿德勒的哲学课）
    parts = re.split(r"[_\-–—·・|／/]+", title or "")
    for part in parts:
        part = part.strip()
        if not part:
            continue
        # 去掉「的哲学课」「之父」等尾巴后仍可作标签
        short = re.sub(
            r"(的)?(哲学课|启示录|导论|入门|讲义|笔记|之父|之母)$",
            "",
            part,
        ).strip()
        if 2 <= len(short) <= 12:
            add(short)
        elif 2 <= len(part) <= 12:
            add(part)

    haystack = f"{title}\n{text_sample[:2000]}"
    for pattern, tag in _KEYWORD_TAGS:
        if pattern.search(haystack):
            add(tag)

    return tags[:5] or ["未命名主题"]


def _parse_llm_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return {}
        try:
            data = json.loads(match.group(0))
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}


async def llm_suggest(
    *,
    base_url: str,
    api_key: str,
    model: str,
    title: str,
    text_sample: str,
) -> tuple[list[str], str]:
    """调用 chat 生成 tags + summary；失败则抛异常由调用方回退。"""
    prompt = (
        "你是个人知识库的归类助手。根据书名与正文片段，输出严格 JSON（不要 markdown）：\n"
        '{"tags":["标签1","标签2"],"summary":"80-160字中文摘要"}\n'
        "规则：\n"
        "1. tags 1~5 个，用可检索的主题词（如：心理学、阿德勒、自我启发、哲学），可多选；\n"
        "2. 禁止用格式词：电子书、PDF、EPUB、笔记、网页、未分类；\n"
        "3. summary 忠实概括内容，不要空话。\n"
        f"书名：{title}\n"
        f"正文片段：\n{text_sample[:3500]}"
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "只输出 JSON 对象，不要其它文字。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 500,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {api_key}"}
    base = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=8.0)) as client:
        resp = await client.post(f"{base}/chat/completions", headers=headers, json=payload)
        resp.raise_for_status()
        body = resp.json()
    content = (
        (((body.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
    )
    data = _parse_llm_json(content)
    raw_tags = data.get("tags") or []
    tags: list[str] = []
    seen: set[str] = set()
    if isinstance(raw_tags, list):
        for item in raw_tags:
            cleaned = _clean_tag(str(item))
            if cleaned and cleaned not in seen:
                seen.add(cleaned)
                tags.append(cleaned)
    summary = str(data.get("summary") or "").strip()
    return tags[:5], summary[:800]


async def suggest_tags_and_summary(
    *,
    title: str,
    text: str,
    llm: dict[str, str] | None,
) -> tuple[list[str], str]:
    """优先 LLM；失败或无 Key 则启发式标签 + 正文截断摘要。"""
    sample = text[:4000]
    fallback_summary = text[:800].rstrip() + ("…" if len(text) > 800 else "")
    fallback_tags = heuristic_tags(title, sample)

    if not llm or not llm.get("api_key"):
        return fallback_tags, fallback_summary

    try:
        tags, summary = await llm_suggest(
            base_url=llm["base_url"],
            api_key=llm["api_key"],
            model=llm["model"],
            title=title,
            text_sample=sample,
        )
        if not tags:
            tags = fallback_tags
        if not summary:
            summary = fallback_summary
        return tags, summary
    except Exception:  # noqa: BLE001
        return fallback_tags, fallback_summary
