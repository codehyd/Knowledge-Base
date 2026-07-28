"""正文段落补全：把锚点扩成完整、有头有尾的可读片段。

支持两类文本：
- 常规书籍正文：以句号/问号等为句子边界。
- 视频转写（几乎没有标点、按行断句）：以换行为句子边界。
"""

from __future__ import annotations

_SENT_END = frozenset("。！？；!?")
_BROKEN_START = frozenset("，。、；：）》」』的了着过在是与及和而则")


def _is_low_punct(text: str, anchor: int, window: int = 600) -> bool:
    """锚点附近标点稀疏（如视频转写）→ 应按行断句。"""
    left = max(0, anchor - window)
    right = min(len(text), anchor + window)
    seg = text[left:right]
    if not seg:
        return False
    punct = sum(1 for ch in seg if ch in _SENT_END)
    newlines = seg.count("\n")
    # 平均每 200 字不到一个句末标点，且有换行 → 视为按行文本
    return punct * 200 < len(seg) and newlines >= 2


def _boundaries(text: str, anchor: int) -> frozenset[str]:
    if _is_low_punct(text, anchor):
        return frozenset("\n") | _SENT_END
    return _SENT_END


def _prev_boundary(text: str, pos: int, ends: frozenset[str], limit: int = 480) -> int:
    """返回 pos 往前最近一个句子边界之后的位置（即句首）。"""
    i = pos
    guard = 0
    while i > 0 and guard < limit:
        if text[i - 1] in ends:
            break
        i -= 1
        guard += 1
    while i < pos and text[i] in " \t\r\n　":
        i += 1
    return i


def _next_boundary(text: str, pos: int, ends: frozenset[str], limit: int = 480) -> int:
    """返回 pos 往后最近一个句子边界之后的位置（含边界字符）。"""
    n = len(text)
    i = pos
    guard = 0
    while i < n and guard < limit:
        ch = text[i]
        i += 1
        guard += 1
        if ch in ends:
            break
    return i


def expand_to_complete_passage(
    full: str,
    anchor: int,
    *,
    needle_len: int = 8,
    max_chars: int = 360,
    min_chars: int = 40,
    prefer_sentences: int = 2,
) -> tuple[int, int]:
    """
    以 anchor 为锚，向前补到句首、向后凑完整句。保持紧凑，不贪多。
    返回 (start, end)，对应 full[start:end]。
    """
    text = full or ""
    n = len(text)
    if not text:
        return 0, 0
    anchor = max(0, min(int(anchor), n - 1))
    needle_len = max(1, int(needle_len))
    ends = _boundaries(text, anchor)

    # 向前补到句首
    start = _prev_boundary(text, anchor, ends)

    # 若仍像残句开头（仅对常规标点文本做此修正），再往前追一句
    if ends == _SENT_END and start < n and text[start] in _BROKEN_START:
        start = _prev_boundary(text, max(0, start - 1), ends, limit=360)

    # 向后逐句补，直到覆盖锚点词并满足句数/字数要求
    end = anchor
    sentences = 0
    while end < n:
        nxt = _next_boundary(text, end, ends)
        if nxt == end:
            break
        end = nxt
        sentences += 1
        covered = end >= anchor + needle_len
        if covered and sentences >= prefer_sentences and (end - start) >= min_chars:
            break
        if covered and (end - start) >= max_chars:
            break

    # 裁掉尾部空白
    while end > start and text[end - 1] in " \t\r\n　":
        end -= 1
    if end <= start:
        end = min(n, anchor + max(needle_len, 1))
    return start, end


def step_expand(
    full: str,
    start: int,
    end: int,
    *,
    direction: str = "after",
    sentences: int = 1,
) -> tuple[int, int]:
    """手动小步扩展：向前/向后各补 sentences 个句子（或转写文本的行）。"""
    text = full or ""
    n = len(text)
    if not text:
        return 0, 0
    start = max(0, min(int(start), n))
    end = max(start, min(int(end), n))
    ends = _boundaries(text, start)

    if direction in ("before", "both"):
        for _ in range(max(1, sentences)):
            pos = start
            while pos > 0 and text[pos - 1] in " \t\r\n　":
                pos -= 1
            if pos <= 0:
                break
            start = _prev_boundary(text, max(0, pos - 1), ends)
    if direction in ("after", "both"):
        for _ in range(max(1, sentences)):
            pos = end
            while pos < n and text[pos] in " \t\r\n　":
                pos += 1
            if pos >= n:
                break
            end = _next_boundary(text, pos, ends)

    while end > start and text[end - 1] in " \t\r\n　":
        end -= 1
    return start, end


def step_shrink(
    full: str,
    start: int,
    end: int,
    *,
    direction: str = "after",
    sentences: int = 1,
) -> tuple[int, int]:
    """手动小步收缩：从头部/尾部去掉 sentences 个句子（或行），至少保留一句。"""
    text = full or ""
    n = len(text)
    start = max(0, min(int(start), n))
    end = max(start, min(int(end), n))
    ends = _boundaries(text, start)

    if direction == "before":
        for _ in range(max(1, sentences)):
            nxt = _next_boundary(text, start, ends)
            if nxt >= end:
                break
            start = nxt
            while start < end and text[start] in " \t\r\n　":
                start += 1
    else:
        for _ in range(max(1, sentences)):
            # 找到最后一句的句首，把尾巴收到上一句末
            cut = end
            while cut > start and text[cut - 1] in " \t\r\n　":
                cut -= 1
            prev = _prev_boundary(text, max(start, cut - 1), ends)
            if prev <= start:
                break
            new_end = prev
            while new_end > start and text[new_end - 1] in " \t\r\n　":
                new_end -= 1
            if new_end <= start:
                break
            end = new_end
    return start, end


def passage_quote(full: str, start: int, end: int, *, max_len: int = 2000) -> str:
    q = (full or "")[start:end].strip()
    if len(q) > max_len:
        q = q[:max_len]
    return q


def ranges_same_passage(a0: int, a1: int, b0: int, b1: int) -> bool:
    """判断两段是否属于同一知识点段落（重叠 / 短段被包含 / 相邻很近）。"""
    if a1 <= a0 or b1 <= b0:
        return False
    inter = max(0, min(a1, b1) - max(a0, b0))
    len_a = a1 - a0
    len_b = b1 - b0
    union = max(a1, b1) - min(a0, b0)
    if union > 0 and inter / union >= 0.45:
        return True
    # 短段大部分落在长段里（含子区间）
    smaller = min(len_a, len_b)
    if smaller > 0 and inter / smaller >= 0.6:
        return True
    # 不相交但几乎贴在一起
    if inter == 0:
        gap = max(a0, b0) - min(a1, b1)
        if 0 <= gap <= 120 and union <= 1200:
            return True
    return False
