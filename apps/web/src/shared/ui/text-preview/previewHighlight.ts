import type { EntryAnnotation } from "@/shared/api/client";
import styles from "./TextPreviewModal.module.css";

export const DEFAULT_COLOR = "#facc15";
export const PRESET_COLORS = [
  { id: "#60a5fa", label: "蓝" },
  { id: "#f47c5a", label: "橙" },
  { id: "#34d399", label: "绿" },
  { id: "#c084fc", label: "紫" },
  { id: "#facc15", label: "黄" },
  { id: "#fb7185", label: "玫" },
  { id: "#2a6f6a", label: "青" },
  { id: "#f97316", label: "深橙" },
  { id: "#818cf8", label: "靛" },
  { id: "#a3e635", label: "黄绿" },
] as const;

const LEGACY_COLOR_HEX: Record<string, string> = {
  yellow: "#facc15",
  teal: "#2a6f6a",
  coral: "#f47c5a",
};

export function normalizeColor(raw?: string | null): string {
  const c = (raw || DEFAULT_COLOR).trim();
  const low = c.toLowerCase();
  if (LEGACY_COLOR_HEX[low]) return LEGACY_COLOR_HEX[low];
  if (/^#[0-9a-f]{6}$/i.test(c)) return low;
  return DEFAULT_COLOR;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = normalizeColor(hex).slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export type MarkSpan = {
  start: number;
  end: number;
  kind: "search" | "ann" | "pending";
  annId?: number;
  color?: string;
  active?: boolean;
  /** 对话预笔记（叠层时正式笔记优先着色） */
  isAnchor?: boolean;
  /** 同一位置叠了几条标注 */
  stackCount?: number;
  stackIds?: number[];
  /** 本连续叠层片段是否显示角标（只在开头显示一次） */
  showBadge?: boolean;
};

export type PendingSel = {
  x: number;
  y: number;
  start: number;
  end: number;
  quote: string;
  color: string;
  placeBelow?: boolean;
};

export function isChatAnchor(ann: EntryAnnotation) {
  return ann.kind === "chat_anchor" || (ann.note || "").startsWith("对话引用");
}

export function anchorLabel(ann: EntryAnnotation) {
  const n = (ann.note || "").trim();
  if (n.startsWith("对话引用｜")) return n.slice("对话引用｜".length).trim() || "对话定位";
  if (n.startsWith("对话引用")) return n.replace(/^对话引用｜?/, "").trim() || "对话定位";
  return n || "对话定位";
}

export function formatTime(value?: string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function collectSearchSpans(
  text: string,
  baseOffset: number,
  query: string,
  activeAbsOffset: number | null,
): MarkSpan[] {
  const q = query.trim();
  if (!q) return [];
  const parts = q.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const pattern =
    parts.length === 1
      ? new RegExp(parts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
      : new RegExp(
          parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"),
          "gi",
        );
  const spans: MarkSpan[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) != null) {
    const start = match.index;
    const end = start + match[0].length;
    const abs = baseOffset + start;
    spans.push({
      start,
      end,
      kind: "search",
      active: activeAbsOffset != null && abs === activeAbsOffset,
    });
    // 避免零宽匹配死循环
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return spans;
}

function collectAnnSpans(
  textLen: number,
  baseOffset: number,
  annotations: EntryAnnotation[],
  activeAnnId: number | null,
  editRange?: { start: number; end: number } | null,
  editColor?: string | null,
  /** 选中某条时只画它自己的真实区间与颜色，避免被更长重叠笔记「吞掉」 */
  focusActiveOnly = false,
): MarkSpan[] {
  const winEnd = baseOffset + textLen;
  const spans: MarkSpan[] = [];
  const list =
    focusActiveOnly && activeAnnId != null
      ? annotations.filter((a) => a.id === activeAnnId)
      : annotations;
  for (const ann of list) {
    const useEdit = activeAnnId === ann.id && editRange != null;
    const rawStart = useEdit ? editRange.start : ann.start_offset;
    const rawEnd = useEdit ? editRange.end : ann.end_offset;
    const a0 = Math.max(rawStart, baseOffset);
    const a1 = Math.min(rawEnd, winEnd);
    if (a1 <= a0) continue;
    spans.push({
      start: a0 - baseOffset,
      end: a1 - baseOffset,
      kind: "ann",
      annId: ann.id,
      color: normalizeColor(
        activeAnnId === ann.id && editColor ? editColor : ann.color,
      ),
      active: activeAnnId === ann.id,
      isAnchor: isChatAnchor(ann),
    });
  }
  return spans;
}

function collectPendingSpan(
  textLen: number,
  baseOffset: number,
  pending: PendingSel | null,
): MarkSpan[] {
  if (!pending) return [];
  const winEnd = baseOffset + textLen;
  const a0 = Math.max(pending.start, baseOffset);
  const a1 = Math.min(pending.end, winEnd);
  if (a1 <= a0) return [];
  return [
    {
      start: a0 - baseOffset,
      end: a1 - baseOffset,
      kind: "pending",
      color: normalizeColor(pending.color),
    },
  ];
}

/** 将区间切成不重叠片段；待确认划选 > 笔记 > 搜索。多条笔记重叠时保留主色并记 stack。 */
export function mergeSpans(spans: MarkSpan[]): MarkSpan[] {
  if (!spans.length) return [];
  const points = new Set<number>();
  for (const s of spans) {
    points.add(s.start);
    points.add(s.end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const out: MarkSpan[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a >= b) continue;
    const covering = spans.filter((s) => s.start <= a && s.end >= b);
    if (!covering.length) continue;
    const pending = covering.find((s) => s.kind === "pending");
    const anns = covering.filter((s) => s.kind === "ann");
    // 主色：优先当前激活，其次正式笔记，再取第一条
    const pickAnn =
      anns.find((s) => s.active) ||
      anns.find((s) => !s.isAnchor) ||
      anns[0] ||
      null;
    const pick = pending ?? pickAnn ?? covering[0];
    const stackIds = [
      ...new Set(anns.map((s) => s.annId).filter((id): id is number => id != null)),
    ];
    const stackCount = stackIds.length;
    const stackKey = stackIds.slice().sort((x, y) => x - y).join(",");
    const last = out[out.length - 1];
    const sameStack =
      last &&
      last.end === a &&
      last.kind === "ann" &&
      pick.kind === "ann" &&
      stackCount > 1 &&
      (last.stackIds || []).join(",") === stackKey;
    const sameSingle =
      last &&
      last.end === a &&
      last.kind === pick.kind &&
      last.annId === pick.annId &&
      last.color === pick.color &&
      last.active === pick.active &&
      (last.stackIds || []).join(",") === stackKey;
    if (sameStack || sameSingle) {
      last!.end = b;
      if (sameStack && pick.active) {
        last!.annId = pick.annId;
        last!.color = pick.color;
        last!.active = true;
        last!.isAnchor = pick.isAnchor;
      }
    } else {
      out.push({
        ...pick,
        start: a,
        end: b,
        stackCount: pick.kind === "ann" ? stackCount : undefined,
        stackIds: pick.kind === "ann" && stackCount > 1 ? stackIds : undefined,
        showBadge: false,
      });
    }
  }
  // 同一叠层组只保留一个角标（取最后一段），避免划选切开后出现两个
  const lastBadgeAt = new Map<string, number>();
  out.forEach((s, i) => {
    if (s.kind === "ann" && s.stackIds && s.stackIds.length > 1) {
      lastBadgeAt.set(s.stackIds.slice().sort((x, y) => x - y).join(","), i);
    }
  });
  for (const idx of lastBadgeAt.values()) {
    out[idx].showBadge = true;
  }
  return out;
}

export function buildHighlightedHtml(
  text: string,
  baseOffset: number,
  query: string,
  activeAbsOffset: number | null,
  annotations: EntryAnnotation[],
  activeAnnId: number | null,
  pending: PendingSel | null,
  editRange?: { start: number; end: number } | null,
  editColor?: string | null,
  showHighlights = true,
  /** 仅编辑弹窗打开时只画当前条；关闭后恢复全部 */
  focusActiveOnly = false,
) {
  const spans = mergeSpans([
    ...collectSearchSpans(text, baseOffset, query, activeAbsOffset),
    ...(showHighlights
      ? collectAnnSpans(
          text.length,
          baseOffset,
          annotations,
          activeAnnId,
          editRange,
          editColor,
          focusActiveOnly,
        )
      : []),
    ...collectPendingSpan(text.length, baseOffset, pending),
  ]);
  if (!spans.length) return escapeHtml(text);

  let html = "";
  let last = 0;
  for (const span of spans) {
    if (span.start > last) html += escapeHtml(text.slice(last, span.start));
    const chunk = escapeHtml(text.slice(span.start, span.end));
    if (span.kind === "ann" || span.kind === "pending") {
      const bg = hexToRgba(normalizeColor(span.color), 0.42);
      const activeCls = span.active ? ` ${styles.annActive}` : "";
      const pendingCls = span.kind === "pending" ? ` ${styles.annPending}` : "";
      const stackedCls =
        span.kind === "ann" && (span.stackCount || 0) > 1 ? ` ${styles.annStacked}` : "";
      const annAttr =
        span.kind === "ann" ? ` data-ann-id="${span.annId}"` : ` data-pending="1"`;
      const stackAttr =
        span.kind === "ann" && span.stackIds && span.stackIds.length > 1
          ? ` data-stack-ids="${span.stackIds.join(",")}"`
          : "";
      const badge =
        !focusActiveOnly &&
        span.showBadge &&
        span.stackCount &&
        span.stackCount > 1
          ? `<sup class="${styles.annBadge}" data-offset-ignore="1" data-count="${span.stackCount}" title="此处有 ${span.stackCount} 条标注" aria-hidden="true"></sup>`
          : "";
      html += `<mark class="${styles.ann}${activeCls}${pendingCls}${stackedCls}" style="background:${bg}"${annAttr}${stackAttr}>${chunk}</mark>${badge}`;
    } else {
      const cls = span.active ? `${styles.hit} ${styles.hitActive}` : styles.hit;
      const abs = baseOffset + span.start;
      html += `<mark class="${cls}" data-abs="${abs}">${chunk}</mark>`;
    }
    last = span.end;
  }
  if (last < text.length) html += escapeHtml(text.slice(last));
  return html;
}

export function collectSpans(
  text: string,
  baseOffset: number,
  query: string,
  activeAbsOffset: number | null,
  annotations: EntryAnnotation[],
  activeAnnId: number | null,
  pending: PendingSel | null,
  editRange?: { start: number; end: number } | null,
  editColor?: string | null,
  showHighlights = true,
  focusActiveOnly = false,
): MarkSpan[] {
  return mergeSpans([
    ...collectSearchSpans(text, baseOffset, query, activeAbsOffset),
    ...(showHighlights
      ? collectAnnSpans(
          text.length,
          baseOffset,
          annotations,
          activeAnnId,
          editRange,
          editColor,
          focusActiveOnly,
        )
      : []),
    ...collectPendingSpan(text.length, baseOffset, pending),
  ]);
}
