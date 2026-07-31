"""知识对话：检索 + 拒答闸门 + LLM + 会话落库。"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.llm import (
    LlmNotConfigured,
    chat_completion,
    cosine_similarity,
    embed_texts,
    load_embedding,
)
from app.modules.chat.models import ChatMessage, ChatSession
from app.modules.chat.schemas import (
    ChatCitation,
    ChatIn,
    ChatMessageListOut,
    ChatMessageOut,
    ChatOut,
    ChatSessionCreate,
    ChatSessionListOut,
    ChatSessionOut,
)
from app.modules.knowledge.models import Chunk, Entry, EntryCategory
from app.modules.knowledge.index import read_entry_text
from app.modules.knowledge.service import knowledge_service
from app.modules.settings_ai.service import settings_ai_service
from app.modules.skills.service import skills_service
from app.modules.sources.models import Source
from app.modules.sources.preview_search import (
    highlight_needle_from_text,
    locate_text_offset,
    search_text_hits,
)
from app.modules.knowledge.passage import expand_to_complete_passage, ranges_same_passage
from app.modules.knowledge.schemas import label_from_anchor_note, merge_point_labels

TOP_K = 6
# 关键词：至少命中分数；向量：cosine 相似度下限
KEYWORD_MIN_SCORE = 1.5
VECTOR_MIN_SCORE = 0.28
SNIPPET_CHARS = 220

_BOLD_CONCEPT_RE = re.compile(r"\*\*([^*，。；\n]{2,40}?)\*\*")
_NUM_ITEM_RE = re.compile(
    r"(?:^|\n)\s*\d+[\.、．)]\s*\**\s*([^\n（(：:*]{2,36})",
    re.MULTILINE,
)
_QUOTE_CONCEPT_RE = re.compile(r"[「『]([^」』]{2,24})[」』]")
_BROKEN_LEAD_RE = re.compile(r"^[，。、；：）》」』的了着过在是与及和]")

REFUSAL_TEXT = (
    "根据当前知识库中的内容，我无法有依据地回答这个问题。"
    "请换一个与已入库资料相关的问题，或先去喂养相关材料。"
)

# 模型须在正文末尾单独一行输出该标记，便于解析；不会展示给用户。
TRUST_MARKER_RE = re.compile(
    r"<<<TRUST:(ok|suspect|conflict)(?:\|([^\n>]*))?>>>",
    re.IGNORECASE,
)

SYSTEM_PROMPT = """你是「空库」知识助手。请主要依据下方【资料片段】回答用户问题。
规则：
1. 优先用资料中的表述总结作答，可适当组织语言，但不要编造资料未提及的事实。
2. 拒答门槛要高：只有【全部】资料片段都与问题明显无关时，才回复一句：资料不足，无法有依据地回答。
   - 只要任一片段相关（含同义、上下位、举例），就必须作答。
   - 问题较笼统（如「是什么」「怎么理解」）时，从最相关片段归纳即可，不要因问法不精确而拒答。
3. 回答简洁、用中文。
4. 不要编造书名、页码或未出现的出处；能答时尽量提到《标题》。
5. 答前轻量质检（仅用于发现库内材料问题，不是用通识补全当权威答案）：
   - 若片段内容可信、无明显硬伤 → 正常作答。
   - 若片段出现明显违背常识的硬事实错误（如基础算术、自相矛盾），或同批片段彼此冲突：
     不要装作资料正确；须点明问题来自哪一条资料（用《标题》），说明「这是知识库材料本身的问题」，
     并提示用户可去知识库修正或删除该条目。不要用库外知识编造「标准答案」冒充库内结论。
6. 正文写完后，必须单独另起一行输出且仅输出一行机器标记（用户界面会去掉）：
   <<<TRUST:ok>>>
   或 <<<TRUST:suspect|简短原因>>>
   或 <<<TRUST:conflict|简短原因>>>
   其中 ok=可正常采信；suspect=有疑点但不确定；conflict=明显错误或资料间冲突。
"""

_RETRY_AFTER_FALSE_REFUSAL = """
补充硬性要求：系统已检索到下方资料片段。只要片段与问题有关，你必须依据片段作答；
禁止回复「资料不足」或同类拒答。问题若笼统，请归纳资料中最相关的说法，并标明《标题》。
"""


def _looks_like_refusal(answer: str) -> bool:
    text = (answer or "").strip()
    if not text:
        return True
    head = text[:100]
    if head.startswith("资料不足"):
        return True
    if "无法有依据地回答" in head:
        return True
    if "根据当前知识库中的内容，我无法" in head:
        return True
    return False


def _hits_seem_relevant(
    message: str,
    chunk_texts: list[str],
    scores: list[float],
    *,
    mode: str,
) -> bool:
    """检索已命中时，粗判是否值得强制作答（防止模型误拒）。"""
    if not chunk_texts:
        return False
    tokens = _tokenize_query(message)
    # 问句很短/很笼统：有命中就倾向作答
    if len(tokens) <= 3:
        return True
    for text in chunk_texts:
        if _keyword_score(text or "", tokens) >= 1.0:
            return True
    if not scores:
        return True
    top = max(float(s) for s in scores)
    if mode == "vector" and top >= VECTOR_MIN_SCORE:
        return True
    if mode == "keyword" and top >= KEYWORD_MIN_SCORE:
        return True
    return False


def _parse_trust_trailer(raw: str) -> tuple[str, str, str]:
    """从模型输出中剥离 TRUST 标记。返回 (answer, trust, trust_note)。"""
    text = (raw or "").strip()
    if not text:
        return "", "ok", ""

    trust = "ok"
    note = ""
    match = None
    for m in TRUST_MARKER_RE.finditer(text):
        match = m
    if match:
        trust = match.group(1).lower()
        note = (match.group(2) or "").strip()
        answer = (text[: match.start()] + text[match.end() :]).strip()
        answer = re.sub(r"\n{3,}", "\n\n", answer).strip()
    else:
        answer = text
        # 弱兜底：模型忘了标记但正文已提示资料有误
        if any(
            tip in answer
            for tip in (
                "知识库材料本身的问题",
                "资料本身有误",
                "资料可能有误",
                "材料明显有误",
                "资料之间冲突",
                "彼此冲突",
            )
        ) or "明显有误" in answer:
            trust = "conflict" if ("冲突" in answer or "明显" in answer) else "suspect"
            note = "模型正文已提示资料存疑"
        elif "存疑" in answer or "可信度" in answer:
            trust = "suspect"
            note = "模型正文已提示资料存疑"

    if trust not in ("ok", "suspect", "conflict"):
        trust = "ok"
    return answer, trust, note[:500]


def _normalize_concept(raw: str) -> str:
    text = (raw or "").strip().strip("*").strip()
    text = re.sub(r"[（(].*?[）)]", "", text).strip()
    compact_ok = re.fullmatch(r"[\u4e00-\u9fffA-Za-z0-9/\-·\s]+", text or "") is not None
    if compact_ok and " " not in text.strip():
        text = re.sub(r"\s+", "", text)
    else:
        text = re.sub(r"\s+", " ", text).strip()
    return text[:40]


def _extract_answer_concepts(answer: str) -> list[str]:
    """从回答中提取知识点标题（加粗、编号项、引号内概念等）。"""
    found: list[str] = []
    for pattern in (_BOLD_CONCEPT_RE, _NUM_ITEM_RE, _QUOTE_CONCEPT_RE):
        for m in pattern.finditer(answer or ""):
            c = _normalize_concept(m.group(1))
            if len(c) >= 2:
                found.append(c)
    seen: set[str] = set()
    out: list[str] = []
    for c in sorted(set(found), key=lambda x: (-len(x), x)):
        key = c.lower()
        if key in seen:
            continue
        if any(key != s and key in s for s in seen):
            continue
        seen.add(key)
        out.append(c)
    return out


def _pick_fallback_label(chunk_text: str) -> str:
    """避开切片开头残句，选一句更像知识点的原文。"""
    text = (chunk_text or "").strip()
    if not text:
        return ""
    pieces = re.split(r"(?<=[。！？\n])", text)
    candidates: list[str] = []
    for p in pieces:
        p = p.strip().replace("\n", " ")
        if len(p) < 8:
            continue
        if _BROKEN_LEAD_RE.match(p):
            continue
        candidates.append(p)
    if candidates:
        scored = sorted(
            candidates,
            key=lambda s: (
                0
                if any(k in s for k in ("思维", "法则", "方法", "问题", "解决", "联想", "检核"))
                else 1,
                len(s),
            ),
        )
        return scored[0][:36]
    return highlight_needle_from_text(text, max_len=36)


def _snippet_around(full: str, offset: int, needle_len: int = 12) -> str:
    if not full or offset < 0:
        return ""
    left = max(0, offset - 36)
    right = min(len(full), offset + max(needle_len, 12) + 140)
    snip = full[left:right].replace("\n", " ").strip()
    if left > 0:
        snip = "…" + snip
    if right < len(full):
        snip = snip + "…"
    if len(snip) > SNIPPET_CHARS:
        snip = snip[:SNIPPET_CHARS].rstrip() + "…"
    return snip


def _find_in_text(text: str, concept: str, start_from: int = 0) -> int:
    if not text or not concept:
        return -1
    idx = text.find(concept, max(0, start_from))
    if idx >= 0:
        return idx
    idx = text.lower().find(concept.lower(), max(0, start_from))
    if idx >= 0:
        return idx
    if start_from <= 0:
        hits, _ = search_text_hits(text, concept, offset=0, limit=1)
        if hits:
            return int(hits[0]["offset"])
        compact_c = re.sub(r"\s+", "", concept)
        if compact_c != concept and len(compact_c) >= 2:
            hits, _ = search_text_hits(text, compact_c, offset=0, limit=1)
            if hits:
                return int(hits[0]["offset"])
    return -1


def _locate_span_near(full: str, quote: str, anchor: int) -> tuple[int, int] | None:
    """把 AI 摘出的 quote 定位回全文 (start, end)，优先取离 anchor 最近的命中。"""
    if not full or not quote:
        return None
    spans: list[tuple[int, int]] = []
    pos = full.find(quote)
    if pos >= 0:
        return pos, pos + len(quote)
    hits, _ = search_text_hits(full, quote, offset=0, limit=8)
    for h in hits:
        spans.append((int(h["offset"]), int(h["offset"]) + int(h["length"])))
    if not spans:
        # 模型可能改写标点（如把换行连成逗号句），忽略双方标点/空白后再匹配
        spans = _punct_fuzzy_spans(full, quote)
    if not spans and len(quote) > 40:
        # AI 可能首尾多抄/少抄，退化为用首尾各一段分别定位再拼区间
        head = quote[:24]
        tail = quote[-24:]
        hh, _ = search_text_hits(full, head, offset=0, limit=8)
        tt, _ = search_text_hits(full, tail, offset=0, limit=8)
        for h in hh:
            hs = int(h["offset"])
            for t in tt:
                te = int(t["offset"]) + int(t["length"])
                if te > hs and te - hs <= 2000:
                    spans.append((hs, te))
        if not spans:
            spans = _punct_fuzzy_spans(full, head)[:1] + [
                (s0, e0) for (s0, e0) in _punct_fuzzy_spans(full, tail)
            ]
            # 首尾各自命中时拼成区间
            if len(spans) >= 2:
                hs = spans[0][0]
                te = spans[-1][1]
                spans = [(hs, te)] if te > hs and te - hs <= 2000 else []
            else:
                spans = []
    if not spans:
        return None
    spans.sort(key=lambda s: abs(s[0] - anchor))
    s, e = spans[0]
    # 模糊匹配会吃掉结尾标点，补回紧邻的句末符号，保证「有尾」
    while e < len(full) and full[e] in "。！？；!?…":
        e += 1
    return s, e


_PUNCT_OR_SPACE_RE = re.compile(r"[\s，。、；：！？,.;:!?\"'“”‘’「」『』«»‹›`（）()【】\[\]《》<>…—\-]+")


def _punct_fuzzy_spans(full: str, quote: str, *, limit: int = 4) -> list[tuple[int, int]]:
    """忽略双方标点与空白后匹配 quote，并把命中映射回原文偏移。"""
    q = _PUNCT_OR_SPACE_RE.sub("", quote or "")
    if len(q) < 6 or not full:
        return []
    keep_chars: list[str] = []
    keep_to_orig: list[int] = []
    for i, ch in enumerate(full):
        if _PUNCT_OR_SPACE_RE.match(ch):
            continue
        keep_chars.append(ch)
        keep_to_orig.append(i)
    keep = "".join(keep_chars)
    if not keep:
        return []
    out: list[tuple[int, int]] = []
    for m in re.finditer(re.escape(q), keep, re.IGNORECASE):
        s_i, e_i = m.start(), m.end() - 1
        if s_i >= len(keep_to_orig) or e_i >= len(keep_to_orig):
            continue
        out.append((keep_to_orig[s_i], keep_to_orig[e_i] + 1))
        if len(out) >= limit:
            break
    return out


_AI_QUOTE_PROMPT = """你在为一个知识库系统标注「知识点出处」。
用户会给你一个 JSON 数组，每项包含：
- i：序号
- label：知识点名称（来自助手的回答）
- text：该知识点附近的原文（可能来自书籍或视频转写，转写文本常有错别字、无标点、按行断句）

请对每一项：
1. 从 text 中**逐字摘出**一段最完整覆盖该知识点的连续原文作为 quote。
   要求：有头有尾（不要从半句话开始、不要在半句话结束）；只保留与该知识点直接相关的内容，
   不要把下一个知识点的内容带进来；转写文本按行摘，可摘多行；一般 40~300 字。
2. 顺手把 label 润色成简洁的知识点标题（2~16 字），含义不变；若原 label 已合适可原样返回。

只输出 JSON 数组，格式：[{"i": 0, "label": "...", "quote": "..."}, ...]
quote 必须是 text 中逐字出现的连续片段（允许保持原有换行），不要改写、不要概括、不要输出其他解释。"""


async def _ai_refine_quotes(
    db: AsyncSession,
    *,
    answer: str,
    items: list[dict[str, str]],
) -> list[dict] | None:
    """让 AI 从原文窗口中为每个知识点摘取更合理的完整片段。失败返回 None。"""
    if not items:
        return None
    try:
        ai_row = await settings_ai_service._get_or_create(db)
        max_tokens = int(getattr(ai_row, "quote_refine_max_tokens", None) or 8000)
        user = (
            "助手回答（供理解知识点语境）：\n"
            + (answer or "")[:800]
            + "\n\n待标注项：\n"
            + json.dumps(items, ensure_ascii=False)
        )
        raw = await chat_completion(
            db,
            [
                {"role": "system", "content": _AI_QUOTE_PROMPT},
                {"role": "user", "content": user},
            ],
            temperature=0.1,
            # 推理模型会把 max_tokens 大量消耗在 reasoning 上，给足余量避免正文被截空
            max_tokens=max_tokens,
        )
        m = re.search(r"\[.*\]", raw or "", re.DOTALL)
        if not m:
            return None
        data = json.loads(m.group(0))
        if not isinstance(data, list):
            return None
        return [d for d in data if isinstance(d, dict)]
    except Exception:  # noqa: BLE001
        return None


def _ranges_same_passage(a0: int, a1: int, b0: int, b1: int) -> bool:
    """判断两段是否属于同一知识点段落（重叠 / 短段被包含 / 相邻很近）。"""
    return ranges_same_passage(a0, a1, b0, b1)


async def _align_citations_with_answer(
    db: AsyncSession,
    *,
    answer: str,
    citations: list[ChatCitation],
    chunk_texts: list[str],
    fulltext_cache: dict[int, str],
    ai_refine: bool = True,
) -> list[ChatCitation]:
    """用回答里的知识点回填出处标签与预高亮位置，避免落到切片开头残句。

    ai_refine=False 时跳过二次模型摘段（显著加速「核对出处」）；
    启发式对齐 + 锚点落库仍会执行。
    """
    concepts = _extract_answer_concepts(answer)
    used_concepts: set[str] = set()
    used_offsets: dict[int, list[tuple[int, int]]] = {}
    refined: list[ChatCitation] = []
    pending_ann: dict[int, dict[str, object]] = {}
    ai_candidates: list[dict[str, object]] = []
    # 原始引用序号 -> refined 下标（去重跳过时可能错位）
    refined_pos_of: dict[int, int] = {}

    for i, cite in enumerate(citations):
        chunk_text = chunk_texts[i] if i < len(chunk_texts) else ""
        full = fulltext_cache.get(cite.entry_id, "") or ""
        label = ""
        highlight_q = ""
        char_offset = cite.char_offset
        snippet = cite.snippet
        quote = ""
        concept_pos = -1

        matched_concept = ""
        local_idx = -1
        highlight_from_text = ""
        for concept in concepts:
            if concept.lower() in used_concepts:
                continue
            # 整词 → 词头（适配 OCR/简称，如 SCAMPER法则 vs SCAMPER）
            probes = [concept]
            if len(concept) >= 6:
                probes.append(concept[: max(4, len(concept) // 2)])
            if len(concept) >= 4:
                probes.append(concept[:4])
            # 英文单独抽出
            en = re.findall(r"[A-Za-z]{3,}", concept)
            probes.extend(en)
            seen_probe: set[str] = set()
            for probe in probes:
                p = (probe or "").strip()
                if len(p) < 2 or p.lower() in seen_probe:
                    continue
                seen_probe.add(p.lower())
                local_idx = _find_in_text(chunk_text, p)
                if local_idx >= 0:
                    matched_concept = concept
                    highlight_from_text = p
                    break
            if matched_concept:
                break
            # 切片附近窗口再找一次（概念可能在重叠区外一点）
            if full and chunk_text:
                base = locate_text_offset(full, chunk_text)
                if base >= 0:
                    left = max(0, base - 240)
                    right = min(len(full), base + len(chunk_text) + 240)
                    window = full[left:right]
                    for probe in probes:
                        p = (probe or "").strip()
                        if len(p) < 2:
                            continue
                        widx = _find_in_text(window, p)
                        if widx >= 0:
                            matched_concept = concept
                            highlight_from_text = p
                            local_idx = -1  # 直接用全书偏移
                            char_offset = left + widx
                            break
                if matched_concept:
                    break

        if matched_concept:
            used_concepts.add(matched_concept.lower())
            label = matched_concept
            highlight_q = highlight_from_text or matched_concept
            if char_offset < 0 or local_idx >= 0:
                chunk_base = locate_text_offset(full, chunk_text) if full and chunk_text else -1
                if chunk_base >= 0 and local_idx >= 0:
                    char_offset = chunk_base + local_idx
                else:
                    char_offset = _find_in_text(full, highlight_q, start_from=max(0, chunk_base))
            concept_pos = char_offset
            if char_offset >= 0 and full:
                start, end = expand_to_complete_passage(
                    full,
                    char_offset,
                    needle_len=max(len(highlight_q), 8),
                    max_chars=320,
                    min_chars=30,
                    prefer_sentences=2,
                )
                char_offset = start
                quote = full[start:end]
                if len(quote) > 2000:
                    quote = quote[:2000]
                    end = start + len(quote)
                snippet = _snippet_around(full, start, min(120, end - start))
        else:
            label = _pick_fallback_label(chunk_text) or cite.point_label or f"片段 {i + 1}"
            highlight_q = label[:40]
            local_idx = _find_in_text(chunk_text, highlight_q) if highlight_q else -1
            chunk_base = locate_text_offset(full, chunk_text) if full and chunk_text else -1
            if chunk_base >= 0 and local_idx >= 0:
                char_offset = chunk_base + local_idx
            elif highlight_q and full:
                char_offset = _find_in_text(full, highlight_q)
            if char_offset >= 0 and full:
                start, end = expand_to_complete_passage(
                    full,
                    char_offset,
                    needle_len=max(len(highlight_q), 8),
                    max_chars=320,
                    min_chars=30,
                    prefer_sentences=2,
                )
                concept_pos = char_offset
                char_offset = start
                quote = full[start:end]
                if len(quote) > 2000:
                    quote = quote[:2000]
                    end = start + len(quote)
                snippet = _snippet_around(full, start, min(120, end - start))
            else:
                quote = (chunk_text or "")[:280]
                char_offset = locate_text_offset(full, chunk_text) if full and chunk_text else -1
                end = char_offset + len(quote) if char_offset >= 0 else 0

        # 同一本书里，若与已收录区间同属一段（重叠/包含/相邻），跳过重复出处
        if char_offset >= 0 and quote:
            end_cur = char_offset + max(1, len(quote))
            ranges = used_offsets.setdefault(cite.entry_id, [])
            dup = False
            for (s0, e0) in ranges:
                if _ranges_same_passage(char_offset, end_cur, s0, e0):
                    dup = True
                    break
            if dup:
                continue
            ranges.append((char_offset, end_cur))

        if char_offset >= 0 and quote:
            end_offset = char_offset + max(1, len(quote))
            pending_ann[i] = {
                "entry_id": cite.entry_id,
                "start": char_offset,
                "end": end_offset,
                "quote": quote[:2000],
                "label": label,
            }
            if concept_pos >= 0 and full:
                # 交给 AI 摘段的窗口：以命中点为锚的前后文
                win_left = max(0, concept_pos - 400)
                win_right = min(len(full), concept_pos + 800)
                ai_candidates.append(
                    {
                        "i": i,
                        "entry_id": cite.entry_id,
                        "anchor": concept_pos,
                        "label": label,
                        "text": full[win_left:win_right],
                    }
                )

        refined_pos_of[i] = len(refined)
        refined.append(
            ChatCitation(
                entry_id=cite.entry_id,
                title=cite.title,
                snippet=snippet or cite.snippet,
                score=cite.score,
                char_offset=char_offset,
                highlight_query=highlight_q or cite.highlight_query,
                annotation_id=None,
                point_label=label or cite.point_label,
            )
        )

    # AI 摘段：从原文窗口中为每个知识点选出更完整、有头有尾的片段
    # 限制条数，避免一次摘段过慢；主路径可关 ai_refine 先出答案
    if ai_refine and ai_candidates:
        ai_candidates = ai_candidates[:4]
        ai_items = [
            {"i": k, "label": str(c["label"]), "text": str(c["text"])}
            for k, c in enumerate(ai_candidates)
        ]
        ai_results = await _ai_refine_quotes(db, answer=answer, items=ai_items)
        if ai_results:
            by_i = {}
            for d in ai_results:
                try:
                    by_i[int(d.get("i"))] = d
                except (TypeError, ValueError):
                    continue
            for k, cand in enumerate(ai_candidates):
                d = by_i.get(k)
                if not d:
                    continue
                new_quote = str(d.get("quote") or "").strip()
                new_label = str(d.get("label") or "").strip()[:16]
                if len(new_quote) < 10:
                    continue
                full = fulltext_cache.get(int(cand["entry_id"]), "") or ""
                span = _locate_span_near(full, new_quote, int(cand["anchor"]))
                if span is None:
                    continue
                s, e = span
                if e - s > 2000:
                    continue
                i = int(cand["i"])
                quote_real = full[s:e]
                meta = pending_ann.get(i)
                if meta is not None:
                    meta["start"] = s
                    meta["end"] = e
                    meta["quote"] = quote_real[:2000]
                    if new_label:
                        meta["label"] = new_label
                refined_pos = refined_pos_of.get(i)
                if refined_pos is not None:
                    upd: dict[str, object] = {
                        "char_offset": s,
                        "snippet": _snippet_around(full, s, min(120, e - s)),
                    }
                    if new_label:
                        upd["point_label"] = new_label
                    refined[refined_pos] = refined[refined_pos].model_copy(update=upd)

    # AI 扩段后可能把原本不相交的两段扩成包含关系，再去一次重；标题合并成「A · B」
    if pending_ann:
        keep_keys, label_updates = _dedupe_pending_by_passage(pending_ann)
        for key, merged_label in label_updates.items():
            meta = pending_ann.get(key)
            if meta is not None and merged_label:
                meta["label"] = merged_label
            rpos = refined_pos_of.get(key)
            if rpos is not None and 0 <= rpos < len(refined) and merged_label:
                refined[rpos] = refined[rpos].model_copy(update={"point_label": merged_label})
        drop_keys = [k for k in list(pending_ann.keys()) if k not in keep_keys]
        for k in drop_keys:
            pending_ann.pop(k, None)
            rpos = refined_pos_of.get(k)
            if rpos is not None and 0 <= rpos < len(refined):
                refined[rpos] = None  # type: ignore[assignment]
        refined = [c for c in refined if c is not None]
        # 重建 refined_pos_of（仅保留仍在 pending 的）
        refined_pos_of = {}
        offset_to_rpos: dict[tuple[int, int], int] = {}
        for j, c in enumerate(refined):
            if c.char_offset is not None and c.char_offset >= 0:
                offset_to_rpos[(c.entry_id, int(c.char_offset))] = j
        for i, meta in pending_ann.items():
            key = (int(meta["entry_id"]), int(meta["start"]))
            if key in offset_to_rpos:
                refined_pos_of[i] = offset_to_rpos[key]

    # 统一落库锚点并回填 annotation_id
    if pending_ann:
        for i, meta in pending_ann.items():
            try:
                ann = await knowledge_service.ensure_chat_anchor(
                    db,
                    int(meta["entry_id"]),
                    start_offset=int(meta["start"]),
                    end_offset=int(meta["end"]),
                    quote=str(meta["quote"]),
                    label=str(meta["label"] or ""),
                )
                rpos = refined_pos_of.get(i)
                if ann is not None and ann.id and rpos is not None:
                    # 用落库后的合并标题回填展示
                    merged_show = label_from_anchor_note(ann.note)
                    upd: dict[str, object] = {"annotation_id": int(ann.id)}
                    if merged_show:
                        upd["point_label"] = merged_show
                    refined[rpos] = refined[rpos].model_copy(update=upd)
            except Exception:  # noqa: BLE001
                pass
    return refined


def _dedupe_pending_by_passage(
    pending: dict[int, dict[str, object]],
) -> tuple[set[int], dict[int, str]]:
    """同一本书里同段落只留最长的一条，并把被合并项的标题并入。

    返回 (保留的 pending key, {保留key: 合并后标题})。
    """
    items = sorted(
        pending.items(),
        key=lambda kv: -(int(kv[1]["end"]) - int(kv[1]["start"])),
    )
    kept: list[tuple[int, int, int, int]] = []  # key, entry, start, end
    keep_keys: set[int] = set()
    absorb: dict[int, list[str]] = {}
    for key, meta in items:
        eid = int(meta["entry_id"])
        s = int(meta["start"])
        e = int(meta["end"])
        host_key = next(
            (
                hk
                for (hk, pe, ps, pe_) in kept
                if eid == pe and ranges_same_passage(s, e, ps, pe_)
            ),
            None,
        )
        if host_key is not None:
            absorb.setdefault(host_key, []).append(str(meta.get("label") or ""))
            continue
        kept.append((key, eid, s, e))
        keep_keys.add(key)

    label_updates: dict[int, str] = {}
    for host_key, extras in absorb.items():
        host_meta = pending.get(host_key)
        if host_meta is None:
            continue
        merged = merge_point_labels(str(host_meta.get("label") or ""), *extras)
        if merged:
            label_updates[host_key] = merged
    return keep_keys, label_updates


_STOPWORDS = {
    "什么",
    "怎么",
    "如何",
    "怎样",
    "是否",
    "为什么",
    "为何",
    "请问",
    "一下",
    "这个",
    "那个",
    "可以",
    "没有",
    "如果",
    "因为",
    "所以",
    "我们",
    "你们",
    "他们",
    "一个",
    "一种",
    "一些",
    "意思",
    "说说",
    "讲讲",
    "看看",
    "是不是",
    "有没有",
    "是什",
    "什么意",
    "么意思",
    "是什么",
    "气是",
    "么意",
}


def _tokenize_query(message: str) -> list[str]:
    text = re.sub(r"[，。！？、；：\"'“”‘’（）()【】\[\]《》<>\s]+", " ", (message or "").strip())
    parts = re.findall(r"[\u4e00-\u9fff]{2,}|[a-z0-9_]{2,}", text, flags=re.I)
    tokens: list[str] = []
    seen: set[str] = set()

    def add(tok: str) -> None:
        t = tok.strip().lower()
        if len(t) < 2 or t in _STOPWORDS or t in seen:
            return
        seen.add(t)
        tokens.append(t)

    for p in parts:
        add(p)
        if re.fullmatch(r"[\u4e00-\u9fff]+", p):
            # 2~3 字窗口，过滤停用词
            for n in (2, 3):
                if len(p) < n:
                    continue
                for i in range(len(p) - n + 1):
                    add(p[i : i + n])
    return tokens[:48]


def _keyword_score(text: str, tokens: list[str]) -> float:
    if not tokens:
        return 0.0
    low = text.lower()
    score = 0.0
    for t in tokens:
        if t not in low:
            continue
        # 更长词权重更高；出现次数有上限
        count = min(3, low.count(t))
        score += count * (1.0 + min(3.0, len(t) / 4.0))
    return score


_NOISE_HINTS = ("copyright", "isbn", "印刷", "责任编辑", "all rights reserved", "cip数据")


def _is_noisy_chunk(text: str) -> bool:
    low = (text or "").lower()
    hits = sum(1 for h in _NOISE_HINTS if h in low)
    return hits >= 2


class ChatService:
    def _title_from_message(self, message: str) -> str:
        text = re.sub(r"\s+", " ", (message or "").strip())
        if not text:
            return "新对话"
        return text[:40] + ("…" if len(text) > 40 else "")

    def _msg_out(self, row: ChatMessage) -> ChatMessageOut:
        citations: list[ChatCitation] = []
        raw = (row.citations_json or "").strip()
        if raw:
            try:
                data = json.loads(raw)
                if isinstance(data, list):
                    citations = [ChatCitation.model_validate(x) for x in data]
            except Exception:
                citations = []
        return ChatMessageOut(
            id=row.id,
            session_id=row.session_id,
            role=row.role,
            content=row.content or "",
            refused=bool(row.refused),
            trust=(getattr(row, "trust", None) or "ok"),
            trust_note=(getattr(row, "trust_note", None) or ""),
            status=(getattr(row, "status", None) or "done"),
            progress=(getattr(row, "progress", None) or ""),
            citations=citations,
            created_at=row.created_at,
        )

    async def list_sessions(self, db: AsyncSession) -> ChatSessionListOut:
        result = await db.execute(
            select(ChatSession).order_by(ChatSession.updated_at.desc(), ChatSession.id.desc())
        )
        rows = list(result.scalars().all())
        return ChatSessionListOut(items=[ChatSessionOut.model_validate(r) for r in rows])

    async def create_session(
        self, db: AsyncSession, payload: ChatSessionCreate | None = None
    ) -> ChatSessionOut:
        payload = payload or ChatSessionCreate()
        row = ChatSession(
            title=(payload.title or "新对话").strip()[:120] or "新对话",
            category_id=payload.category_id,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return ChatSessionOut.model_validate(row)

    async def delete_session(self, db: AsyncSession, session_id: int) -> None:
        row = await db.get(ChatSession, session_id)
        if not row:
            raise HTTPException(status_code=404, detail="会话不存在")
        await db.execute(delete(ChatMessage).where(ChatMessage.session_id == session_id))
        await db.delete(row)
        await db.commit()

    async def list_messages(self, db: AsyncSession, session_id: int) -> ChatMessageListOut:
        session = await db.get(ChatSession, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="会话不存在")
        result = await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.id.asc())
        )
        rows = list(result.scalars().all())
        return ChatMessageListOut(items=[self._msg_out(r) for r in rows])

    async def _ensure_session(
        self, db: AsyncSession, *, session_id: int | None, category_id: int | None, message: str
    ) -> ChatSession:
        if session_id is not None:
            row = await db.get(ChatSession, session_id)
            if not row:
                raise HTTPException(status_code=404, detail="会话不存在")
            return row
        row = ChatSession(title=self._title_from_message(message), category_id=category_id)
        db.add(row)
        await db.flush()
        return row

    async def _session_pending_assistant(
        self, db: AsyncSession, session_id: int
    ) -> ChatMessage | None:
        result = await db.execute(
            select(ChatMessage)
            .where(
                ChatMessage.session_id == session_id,
                ChatMessage.role == "assistant",
                ChatMessage.status == "pending",
            )
            .order_by(ChatMessage.id.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def _begin_turn(
        self,
        db: AsyncSession,
        session: ChatSession,
        *,
        user_text: str,
        category_id: int | None,
    ) -> ChatMessage:
        """立即落库用户消息 + pending 助手占位，便于切页后仍能看到进度。"""
        existing = await db.execute(
            select(ChatMessage.id).where(ChatMessage.session_id == session.id).limit(1)
        )
        if existing.scalar_one_or_none() is None:
            session.title = self._title_from_message(user_text)
        if category_id is not None:
            session.category_id = category_id
        session.updated_at = datetime.now(timezone.utc)

        db.add(
            ChatMessage(
                session_id=session.id,
                role="user",
                content=user_text,
                refused=False,
                trust="ok",
                trust_note="",
                status="done",
                citations_json="",
            )
        )
        assistant = ChatMessage(
            session_id=session.id,
            role="assistant",
            content="",
            refused=False,
            trust="ok",
            trust_note="",
            status="pending",
            progress="accepted",
            citations_json="",
        )
        db.add(assistant)
        await db.commit()
        await db.refresh(session)
        await db.refresh(assistant)
        return assistant

    async def _set_progress(
        self, db: AsyncSession, assistant: ChatMessage, stage: str
    ) -> None:
        """写回 pending 阶段，供前端轮询展示动向。失败不阻断主流程。"""
        if (assistant.status or "") != "pending":
            return
        try:
            assistant.progress = (stage or "")[:40]
            await db.commit()
            await db.refresh(assistant)
        except Exception:  # noqa: BLE001
            try:
                await db.rollback()
            except Exception:  # noqa: BLE001
                pass

    async def _finish_assistant(
        self,
        db: AsyncSession,
        assistant: ChatMessage,
        *,
        answer: str,
        refused: bool,
        citations: list[ChatCitation],
        trust: str = "ok",
        trust_note: str = "",
        status: str = "done",
        retrieval: str = "keyword",
    ) -> ChatOut:
        cites_raw = json.dumps(
            [c.model_dump() for c in citations],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        assistant.content = answer
        assistant.refused = refused
        assistant.trust = trust if trust in ("ok", "suspect", "conflict") else "ok"
        assistant.trust_note = (trust_note or "")[:500]
        assistant.status = status if status in ("done", "pending", "error") else "done"
        assistant.progress = ""
        assistant.citations_json = cites_raw

        session = await db.get(ChatSession, assistant.session_id)
        if session:
            session.updated_at = datetime.now(timezone.utc)

        await db.commit()
        await db.refresh(assistant)

        return ChatOut(
            answer=answer,
            refused=refused,
            trust=assistant.trust or "ok",
            trust_note=assistant.trust_note or "",
            citations=citations,
            retrieval=retrieval,
            session_id=assistant.session_id,
            status=assistant.status or "done",
            pending_message_id=None,
        )

    async def begin_chat(self, db: AsyncSession, payload: ChatIn) -> ChatOut:
        """受理提问：立刻落库，返回 pending，由后台任务完成生成。"""
        if not await settings_ai_service.is_configured(db):
            raise HTTPException(status_code=400, detail="尚未配置 API Key，请先到设置页填写")

        message = payload.message.strip()
        if not message:
            raise HTTPException(status_code=400, detail="问题不能为空")

        session = await self._ensure_session(
            db,
            session_id=payload.session_id,
            category_id=payload.category_id,
            message=message,
        )
        await db.commit()
        await db.refresh(session)

        pending = await self._session_pending_assistant(db, session.id)
        if pending is not None:
            raise HTTPException(
                status_code=409,
                detail="当前会话仍有回答在生成中，请稍候再发送或稍后再打开该会话",
            )

        assistant = await self._begin_turn(
            db,
            session,
            user_text=message,
            category_id=payload.category_id,
        )
        return ChatOut(
            answer="",
            refused=False,
            trust="ok",
            trust_note="",
            citations=[],
            retrieval="pending",
            session_id=session.id,
            status="pending",
            pending_message_id=assistant.id,
        )

    async def complete_pending(self, db: AsyncSession, assistant_message_id: int) -> None:
        """后台：检索 + 生成，写回 pending 助手消息。"""
        assistant = await db.get(ChatMessage, assistant_message_id)
        if not assistant or assistant.role != "assistant":
            return
        if (assistant.status or "") != "pending":
            return

        # 取紧邻的上一条用户消息
        result = await db.execute(
            select(ChatMessage)
            .where(
                ChatMessage.session_id == assistant.session_id,
                ChatMessage.role == "user",
                ChatMessage.id < assistant.id,
            )
            .order_by(ChatMessage.id.desc())
            .limit(1)
        )
        user_msg = result.scalar_one_or_none()
        if not user_msg or not (user_msg.content or "").strip():
            await self._finish_assistant(
                db,
                assistant,
                answer="无法找到对应的提问内容，请重新发送。",
                refused=True,
                citations=[],
                status="error",
            )
            return

        session = await db.get(ChatSession, assistant.session_id)
        category_id = session.category_id if session else None
        message = (user_msg.content or "").strip()

        try:
            await self._set_progress(db, assistant, "retrieving")
            hits, mode = await self._retrieve(db, message, category_id=category_id)
            if not hits:
                await self._finish_assistant(
                    db,
                    assistant,
                    answer=REFUSAL_TEXT,
                    refused=True,
                    citations=[],
                    retrieval=mode,
                    status="done",
                )
                return

            context_blocks: list[str] = []
            citations: list[ChatCitation] = []
            chunk_texts: list[str] = []
            fulltext_cache: dict[int, str] = {}
            for i, (chunk, entry, score) in enumerate(hits, start=1):
                title = entry.title or f"条目 #{entry.id}"
                chunk_text = (chunk.text or "").strip()
                chunk_texts.append(chunk_text)
                snippet = chunk_text.replace("\n", " ")
                if len(snippet) > SNIPPET_CHARS:
                    snippet = snippet[:SNIPPET_CHARS].rstrip() + "…"

                if entry.id not in fulltext_cache:
                    source = (
                        await db.get(Source, entry.source_id) if entry.source_id else None
                    )
                    fulltext_cache[entry.id] = read_entry_text(entry, source)
                full = fulltext_cache[entry.id]
                char_offset = locate_text_offset(full, chunk_text) if full else -1

                context_blocks.append(f"[{i}] 《{title}》\n{chunk.text}")
                citations.append(
                    ChatCitation(
                        entry_id=entry.id,
                        title=title,
                        snippet=snippet,
                        score=round(float(score), 4),
                        char_offset=char_offset,
                        highlight_query="",
                        annotation_id=None,
                        point_label="",
                    )
                )

            user_content = (
                "【资料片段】\n"
                + "\n\n".join(context_blocks)
                + "\n\n【用户问题】\n"
                + message
            )
            system_prompt = SYSTEM_PROMPT
            try:
                skill_addon = skills_service.build_system_addon()
                if skill_addon:
                    system_prompt = SYSTEM_PROMPT + skill_addon
            except Exception:  # noqa: BLE001
                pass
            await self._set_progress(db, assistant, "generating")
            ai_row = await settings_ai_service._get_or_create(db)
            max_tokens = int(getattr(ai_row, "chat_max_tokens", None) or 1200)
            raw_answer = await chat_completion(
                db,
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                max_tokens=max_tokens,
            )
            answer, trust, trust_note = _parse_trust_trailer(raw_answer or "")
            hit_scores = [float(c.score) for c in citations]
            # 有相关命中却被模型误拒：再生成一次，强制依据片段作答
            if _looks_like_refusal(answer) and _hits_seem_relevant(
                message, chunk_texts, hit_scores, mode=mode
            ):
                raw_retry = await chat_completion(
                    db,
                    [
                        {
                            "role": "system",
                            "content": system_prompt + _RETRY_AFTER_FALSE_REFUSAL,
                        },
                        {"role": "user", "content": user_content},
                    ],
                    max_tokens=max_tokens,
                    temperature=0.1,
                )
                answer, trust, trust_note = _parse_trust_trailer(raw_retry or "")

            if _looks_like_refusal(answer):
                await self._finish_assistant(
                    db,
                    assistant,
                    answer=REFUSAL_TEXT,
                    refused=True,
                    citations=[],
                    retrieval=mode,
                    status="done",
                )
                return

            await self._set_progress(db, assistant, "citing")
            # 先做本地启发式对齐并立刻返回答案，避免二次模型摘段卡住「核对出处」
            citations_fast = await _align_citations_with_answer(
                db,
                answer=answer,
                citations=citations,
                chunk_texts=chunk_texts,
                fulltext_cache=fulltext_cache,
                ai_refine=False,
            )

            await self._finish_assistant(
                db,
                assistant,
                answer=answer,
                refused=False,
                citations=citations_fast,
                trust=trust,
                trust_note=trust_note,
                retrieval=mode,
                status="done",
            )

            # 后台精修出处（失败不影响已返回的回答）
            try:
                citations_polished = await _align_citations_with_answer(
                    db,
                    answer=answer,
                    citations=citations,
                    chunk_texts=chunk_texts,
                    fulltext_cache=fulltext_cache,
                    ai_refine=True,
                )
                row = await db.get(ChatMessage, assistant.id)
                if row is not None and (row.status or "") == "done" and not row.refused:
                    row.citations_json = json.dumps(
                        [c.model_dump() for c in citations_polished],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    await db.commit()
            except Exception:  # noqa: BLE001
                pass
        except LlmNotConfigured as exc:
            await self._finish_assistant(
                db,
                assistant,
                answer=str(exc) or "尚未配置 API Key",
                refused=True,
                citations=[],
                status="error",
            )
        except Exception as exc:  # noqa: BLE001
            await self._finish_assistant(
                db,
                assistant,
                answer=f"模型调用失败：{exc}",
                refused=True,
                citations=[],
                status="error",
            )

    async def _retrieve(
        self,
        db: AsyncSession,
        message: str,
        *,
        category_id: int | None,
    ) -> tuple[list[tuple[Chunk, Entry, float]], str]:
        q = (
            select(Chunk, Entry)
            .join(Entry, Entry.id == Chunk.entry_id)
            .order_by(Chunk.entry_id, Chunk.ord)
        )
        if category_id is not None:
            q = q.join(EntryCategory, EntryCategory.entry_id == Entry.id).where(
                EntryCategory.category_id == category_id
            )

        rows = list((await db.execute(q)).all())
        if not rows:
            return [], "keyword"

        # 尝试向量
        query_vecs = await embed_texts(db, [message])
        if query_vecs and query_vecs[0]:
            qv = query_vecs[0]
            scored: list[tuple[Chunk, Entry, float]] = []
            for chunk, entry in rows:
                vec = load_embedding(chunk.embedding)
                if not vec:
                    continue
                sim = cosine_similarity(qv, vec)
                if sim >= VECTOR_MIN_SCORE:
                    scored.append((chunk, entry, sim))
            scored.sort(key=lambda x: x[2], reverse=True)
            if scored:
                return scored[:TOP_K], "vector"

        # 关键词降级
        tokens = _tokenize_query(message)
        scored_kw: list[tuple[Chunk, Entry, float]] = []
        for chunk, entry in rows:
            if _is_noisy_chunk(chunk.text or ""):
                continue
            score = _keyword_score(chunk.text or "", tokens)
            # 标题命中加权
            score += _keyword_score(entry.title or "", tokens) * 1.2
            if score >= KEYWORD_MIN_SCORE:
                scored_kw.append((chunk, entry, score))
        scored_kw.sort(key=lambda x: x[2], reverse=True)
        return scored_kw[:TOP_K], "keyword"


chat_service = ChatService()
