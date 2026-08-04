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
    (re.compile(r"社会[学学]|sociology|sociolog", re.I), "社会学"),
    (re.compile(r"自我启发"), "自我启发"),
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
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "life",
    "as",
    "of",
    "to",
    "in",
    "on",
    "or",
    "an",
    "a",
}

# 英文虚词 / 书名碎片，禁止进侧栏分类
_EN_STOPWORDS = {
    "a",
    "an",
    "the",
    "and",
    "or",
    "of",
    "to",
    "in",
    "on",
    "for",
    "with",
    "from",
    "by",
    "as",
    "at",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "into",
    "over",
    "under",
    "about",
    "after",
    "before",
    "between",
    "through",
    "during",
    "without",
    "within",
    "than",
    "then",
    "so",
    "if",
    "but",
    "not",
    "no",
    "nor",
    "all",
    "any",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "only",
    "own",
    "same",
    "too",
    "very",
    "can",
    "will",
    "just",
    "don",
    "should",
    "now",
    "life",
    "practice",
    "promise",
    "book",
    "volume",
    "part",
    "chapter",
    "edition",
    "vol",
    "vs",
    "et",
    "al",
}

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_ASCII_WORD_RE = re.compile(r"^[A-Za-z0-9]+$")
# 纯数字或书号尾巴
_ID_TAIL_RE = re.compile(r"^\d{5,}$")


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


def _has_cjk(text: str) -> bool:
    return bool(_CJK_RE.search(text or ""))


def is_good_tag(name: str) -> bool:
    """侧栏分类质量门闩：拒绝英文虚词、书名碎片、过长短句。"""
    raw = (name or "").strip()
    if not raw:
        return False
    # 保留原始空格判断前先规范化展示用名
    compact = re.sub(r"\s+", "", raw)
    compact = compact.strip("#·-_/\\")
    if len(compact) < 2 or len(compact) > 16:
        return False
    lower = compact.lower()
    if lower in _FORMAT_NOISE or compact in _FORMAT_NOISE:
        return False
    if lower in _EN_STOPWORDS:
        return False
    if _ID_TAIL_RE.match(compact):
        return False
    # 纯英文：仅允许「像学科/专有名词」的较长词，禁止 the/and/forest 等书名切片
    if _ASCII_WORD_RE.match(compact):
        if lower in _EN_STOPWORDS:
            return False
        # 过短英文一律不要（Forest/Trees/The）
        if len(compact) <= 6:
            return False
        # 允许 Sociology / Psychology 这类学科词（首字母大写或全小写均可，长度够）
        if len(compact) < 8:
            return False
    # 含大量标点的「标题整句」不作分类（如视频花哨标题）
    punct = len(re.findall(r"[!！?？,，.。:：;；…—]", raw))
    if punct >= 2:
        return False
    if "！" in raw or "!" in raw:
        return False
    return True


def _clean_tag(name: str) -> str:
    name = re.sub(r"\s+", "", (name or "").strip())
    name = name.strip("#·-_/\\")
    if not is_good_tag(name):
        return ""
    return name


def heuristic_tags(title: str, text_sample: str = "") -> list[str]:
    """无 Key 时：优先中文书名片段 + 关键词映射；不把英文书名切片当分类。"""
    tags: list[str] = []
    seen: set[str] = set()

    def add(tag: str) -> None:
        cleaned = _clean_tag(tag)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            tags.append(cleaned)

    # 书名按常见分隔符拆成片段；仅收中文可读片段（避免 The/Forest/and）
    parts = re.split(r"[_\-–—·・|／/]+", title or "")
    for part in parts:
        part = part.strip()
        if not part or not _has_cjk(part):
            continue
        # 去掉「的哲学课」「之父」等尾巴后仍可作标签
        short = re.sub(
            r"(的)?(哲学课|启示录|导论|入门|讲义|笔记|之父|之母)$",
            "",
            part,
        ).strip()
        candidate = short if 2 <= len(short) <= 12 else part
        if 2 <= len(candidate) <= 12:
            add(candidate)

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
        "1. tags 1~4 个，必须是可检索的中文主题词（学科/人物/流派），如：心理学、社会学、阿德勒；\n"
        "2. 禁止：书名英文切片（The/Forest/and）、格式词（电子书/PDF/EPUB）、整句标题、感叹号口号；\n"
        "3. 中英混排书名时，用中文主题概括，不要把英文单词拆成标签；\n"
        "4. summary 忠实概括内容，不要空话。\n"
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
