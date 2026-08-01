/** 按正文相对字符偏移滚动；比「整段比例估算」更接近真实阅读位置 */
export function scrollToTextOffset(
  container: HTMLElement,
  localOffset: number,
  options?: { align?: "start" | "center" },
): boolean {
  const align = options?.align ?? "start";
  const target = Math.max(0, Math.floor(localOffset));
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (seen + len >= target) {
      const range = document.createRange();
      const at = Math.min(Math.max(0, target - seen), Math.max(0, len - 1));
      try {
        range.setStart(node, at);
        range.collapse(true);
      } catch {
        return false;
      }
      const rect = range.getBoundingClientRect();
      const box = container.getBoundingClientRect();
      if (rect.height === 0 && rect.top === 0 && rect.bottom === 0) {
        // 尚未完成布局时放弃，交给重试
        return false;
      }
      const pad =
        align === "center" ? Math.min(box.height * 0.35, 120) : Math.min(24, box.height * 0.08);
      container.scrollTop += rect.top - box.top - pad;
      return true;
    }
    seen += len;
    node = walker.nextNode() as Text | null;
  }
  return false;
}

export function applyAnchorScroll(
  el: HTMLDivElement,
  textLen: number,
  segOffset: number,
  anchorChar: number,
) {
  const local = Math.max(0, Math.min(textLen, anchorChar - segOffset));
  if (scrollToTextOffset(el, local, { align: "start" })) return;
  // 回退：比例定位（去掉向下偏移，避免系统性偏上）
  const ratio = Math.min(1, Math.max(0, local / Math.max(1, textLen)));
  const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
  el.scrollTop = Math.min(maxScroll, Math.max(0, ratio * maxScroll));
}

function isOffsetIgnoredNode(node: Node, container: HTMLElement): boolean {
  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && el !== container) {
    if (el.hasAttribute("data-offset-ignore")) return true;
    el = el.parentElement;
  }
  return false;
}

/** 把 Range 边界规范到正文文本节点（跳过角标等装饰） */
function normalizeTextPoint(
  container: HTMLElement,
  node: Node,
  offset: number,
): { node: Text; offset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    if (isOffsetIgnoredNode(node, container)) return null;
    return { node: node as Text, offset };
  }
  const kids = node.childNodes;
  const probe =
    offset < kids.length
      ? kids[offset]
      : offset > 0
        ? kids[offset - 1]
        : null;
  if (!probe) return null;

  if (offset < kids.length) {
    // 落在 child 开头：找该子树第一个正文文本
    if (probe.nodeType === Node.TEXT_NODE && !isOffsetIgnoredNode(probe, container)) {
      return { node: probe as Text, offset: 0 };
    }
    if (probe.nodeType === Node.ELEMENT_NODE && !isOffsetIgnoredNode(probe, container)) {
      const walker = document.createTreeWalker(probe, NodeFilter.SHOW_TEXT);
      let t: Node | null;
      while ((t = walker.nextNode())) {
        if (!isOffsetIgnoredNode(t, container)) return { node: t as Text, offset: 0 };
      }
    }
    // 跳过 ignore 节点，继续往后找
    let sib: Node | null = probe.nextSibling;
    while (sib) {
      if (sib.nodeType === Node.TEXT_NODE && !isOffsetIgnoredNode(sib, container)) {
        return { node: sib as Text, offset: 0 };
      }
      if (sib.nodeType === Node.ELEMENT_NODE && !isOffsetIgnoredNode(sib, container)) {
        const walker = document.createTreeWalker(sib, NodeFilter.SHOW_TEXT);
        let t: Node | null;
        while ((t = walker.nextNode())) {
          if (!isOffsetIgnoredNode(t, container)) return { node: t as Text, offset: 0 };
        }
      }
      sib = sib.nextSibling;
    }
    return null;
  }

  // offset === kids.length：落在节点末尾
  if (probe.nodeType === Node.TEXT_NODE && !isOffsetIgnoredNode(probe, container)) {
    return { node: probe as Text, offset: (probe.textContent || "").length };
  }
  if (probe.nodeType === Node.ELEMENT_NODE && !isOffsetIgnoredNode(probe, container)) {
    const walker = document.createTreeWalker(probe, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    let t: Node | null;
    while ((t = walker.nextNode())) {
      if (!isOffsetIgnoredNode(t, container)) last = t as Text;
    }
    if (last) return { node: last, offset: (last.textContent || "").length };
  }
  return null;
}

function plainOffsetInContainer(
  container: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  const point = normalizeTextPoint(container, node, offset);
  let len = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let t: Node | null;
  while ((t = walker.nextNode())) {
    if (isOffsetIgnoredNode(t, container)) continue;
    if (point && t === point.node) {
      return len + Math.min(point.offset, (t.textContent || "").length);
    }
    // 边界落在角标等装饰节点上：取该装饰之前的正文字符数
    if (
      !point &&
      (t === node ||
        (node.nodeType === Node.ELEMENT_NODE && (node as Element).contains(t)))
    ) {
      return len;
    }
    if (
      !point &&
      node.nodeType === Node.ELEMENT_NODE &&
      isOffsetIgnoredNode(node, container) &&
      node.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      return len;
    }
    len += (t.textContent || "").length;
  }
  return point ? len : len;
}

function plainTextOfContainer(container: HTMLElement): string {
  let s = "";
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let t: Node | null;
  while ((t = walker.nextNode())) {
    if (isOffsetIgnoredNode(t, container)) continue;
    s += t.textContent || "";
  }
  return s;
}

export function clampPopupPos(x: number, y: number) {
  const margin = 16;
  const approxW = 360;
  const approxH = 56;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = Math.min(Math.max(x, margin + approxW / 2), vw - margin - approxW / 2);
  // 默认浮层在锚点上方；太靠上则改到下方，避免「飞出屏幕」
  const placeBelow = y < margin + approxH;
  let cy = placeBelow ? y + 12 : y;
  cy = Math.min(Math.max(cy, margin), vh - margin);
  return { x: cx, y: cy, placeBelow };
}

export function getSelectionOffsets(
  container: HTMLElement,
  baseOffset: number,
  pointer?: { x: number; y: number } | null,
) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const startRel = plainOffsetInContainer(container, range.startContainer, range.startOffset);
  const endRel = plainOffsetInContainer(container, range.endContainer, range.endOffset);
  if (startRel == null || endRel == null || endRel <= startRel) return null;
  if (endRel - startRel > 2000) return null;

  const plain = plainTextOfContainer(container);
  const quote = plain.slice(startRel, endRel);
  if (!quote.trim()) return null;

  // 大段划选时整段 boundingRect 顶部可能远在视口外；优先用指针位置 / 末行可见矩形
  let x = pointer?.x ?? 0;
  let y = pointer?.y ?? 0;
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if ((!x && !y) || pointer == null) {
    const last = rects[rects.length - 1];
    const first = rects[0];
    const pick =
      last && last.bottom > 0 && last.top < window.innerHeight
        ? last
        : first && first.bottom > 0 && first.top < window.innerHeight
          ? first
          : last || first || range.getBoundingClientRect();
    x = pick.left + pick.width / 2;
    y = pick.top;
  } else if (rects.length) {
    // 指针附近那一行，避免整段矩形把浮层拉飞
    let best = rects[rects.length - 1];
    let bestDist = Infinity;
    for (const r of rects) {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot(cx - pointer.x, cy - pointer.y);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    x = pointer.x;
    y = Math.min(pointer.y, best.top + 4);
  }

  const pos = clampPopupPos(x, y);
  return {
    start: baseOffset + startRel,
    end: baseOffset + endRel,
    quote,
    x: pos.x,
    y: pos.y,
    placeBelow: pos.placeBelow,
  };
}
