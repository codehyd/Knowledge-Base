import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  HighlightOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { App, Button, Input, Modal, Popconfirm, Select, Space, Typography } from "antd";
import { api, type EntryAnnotation } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import styles from "./TextPreviewModal.module.css";

export type PreviewSegment = {
  text: string;
  char_count: number;
  offset: number;
  truncated: boolean;
};

export type PreviewSearchHit = {
  offset: number;
  length: number;
  snippet: string;
};

export type PreviewSearchPage = {
  total: number;
  offset: number;
  hits: PreviewSearchHit[];
};

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  loadSegment: (offset: number, limit: number) => Promise<PreviewSegment>;
  searchAll: (
    query: string,
    params?: { offset?: number; limit?: number },
  ) => Promise<PreviewSearchPage>;
  /** 传入后启用高亮/笔记（知识库条目） */
  entryId?: number | null;
};

const WINDOW = 10000;
const PAD = 1800;
const PAGE_SIZE = 100;
const OVERLAP = 1200;
const SCROLL_EDGE = 72;
const PAGE_CHARS = 8000;
const DEFAULT_COLOR = "#facc15";
const PRESET_COLORS = [
  { id: "#facc15", label: "黄" },
  { id: "#2a6f6a", label: "青" },
  { id: "#f47c5a", label: "橙" },
  { id: "#60a5fa", label: "蓝" },
  { id: "#c084fc", label: "紫" },
] as const;

const LEGACY_COLOR_HEX: Record<string, string> = {
  yellow: "#facc15",
  teal: "#2a6f6a",
  coral: "#f47c5a",
};

function normalizeColor(raw?: string | null): string {
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

const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 18, 20, 22] as const;
const FONT_WEIGHT_OPTIONS = [
  { value: 400, label: "常规" },
  { value: 500, label: "中等" },
  { value: 600, label: "半粗" },
  { value: 700, label: "粗体" },
] as const;
const FONT_SIZE_KEY = "kongku.preview.fontSize";
const FONT_WEIGHT_KEY = "kongku.preview.fontWeight";

function readStoredFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_SIZE_KEY));
    if (FONT_SIZE_OPTIONS.includes(n as (typeof FONT_SIZE_OPTIONS)[number])) return n;
  } catch {
    /* ignore */
  }
  return 13;
}

function readStoredFontWeight(): number {
  try {
    const n = Number(localStorage.getItem(FONT_WEIGHT_KEY));
    if (FONT_WEIGHT_OPTIONS.some((o) => o.value === n)) return n;
  } catch {
    /* ignore */
  }
  return 400;
}

type MarkSpan = {
  start: number;
  end: number;
  kind: "search" | "ann" | "pending";
  annId?: number;
  color?: string;
  active?: boolean;
};

type PendingSel = {
  x: number;
  y: number;
  start: number;
  end: number;
  quote: string;
  color: string;
};

function calcPageInfo(viewPos: number, totalChars: number) {
  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalChars) / PAGE_CHARS));
  const currentPage = Math.min(
    totalPages,
    Math.max(1, Math.floor(Math.max(0, viewPos) / PAGE_CHARS) + 1),
  );
  return { currentPage, totalPages };
}

function escapeHtml(s: string) {
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
  const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
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
  }
  return spans;
}

function collectAnnSpans(
  textLen: number,
  baseOffset: number,
  annotations: EntryAnnotation[],
  activeAnnId: number | null,
): MarkSpan[] {
  const winEnd = baseOffset + textLen;
  const spans: MarkSpan[] = [];
  for (const ann of annotations) {
    const a0 = Math.max(ann.start_offset, baseOffset);
    const a1 = Math.min(ann.end_offset, winEnd);
    if (a1 <= a0) continue;
    spans.push({
      start: a0 - baseOffset,
      end: a1 - baseOffset,
      kind: "ann",
      annId: ann.id,
      color: normalizeColor(ann.color),
      active: activeAnnId === ann.id,
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

/** 将区间切成不重叠片段；待确认划选 > 笔记 > 搜索 */
function mergeSpans(spans: MarkSpan[]): MarkSpan[] {
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
    const ann = covering.find((s) => s.kind === "ann");
    const pick = pending ?? ann ?? covering[0];
    const last = out[out.length - 1];
    if (
      last &&
      last.end === a &&
      last.kind === pick.kind &&
      last.annId === pick.annId &&
      last.color === pick.color &&
      last.active === pick.active
    ) {
      last.end = b;
    } else {
      out.push({ ...pick, start: a, end: b });
    }
  }
  return out;
}

function buildHighlightedHtml(
  text: string,
  baseOffset: number,
  query: string,
  activeAbsOffset: number | null,
  annotations: EntryAnnotation[],
  activeAnnId: number | null,
  pending: PendingSel | null,
) {
  const spans = mergeSpans([
    ...collectSearchSpans(text, baseOffset, query, activeAbsOffset),
    ...collectAnnSpans(text.length, baseOffset, annotations, activeAnnId),
    ...collectPendingSpan(text.length, baseOffset, pending),
  ]);
  if (!spans.length) return escapeHtml(text);

  let html = "";
  let last = 0;
  for (const span of spans) {
    if (span.start > last) html += escapeHtml(text.slice(last, span.start));
    const chunk = escapeHtml(text.slice(span.start, span.end));
    if (span.kind === "ann" || span.kind === "pending") {
      const bg = hexToRgba(span.color, 0.42);
      const activeCls = span.active ? ` ${styles.annActive}` : "";
      const pendingCls = span.kind === "pending" ? ` ${styles.annPending}` : "";
      const annAttr =
        span.kind === "ann" ? ` data-ann-id="${span.annId}"` : ` data-pending="1"`;
      html += `<mark class="${styles.ann}${activeCls}${pendingCls}" style="background:${bg}"${annAttr}>${chunk}</mark>`;
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

function getSelectionOffsets(container: HTMLElement, baseOffset: number) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  const startRel = pre.toString().length;
  const quote = range.toString();
  if (!quote.trim()) return null;
  const endRel = startRel + quote.length;
  if (endRel <= startRel || endRel - startRel > 2000) return null;
  const rect = range.getBoundingClientRect();
  return {
    start: baseOffset + startRel,
    end: baseOffset + endRel,
    quote,
    x: rect.left + rect.width / 2,
    y: rect.top,
  };
}

function formatTime(value?: string | null) {
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

export function TextPreviewModal({
  open,
  title,
  onClose,
  loadSegment,
  searchAll,
  entryId = null,
}: Props) {
  const { message } = App.useApp();
  const bodyRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const baseOffsetRef = useRef(0);
  const segmentRef = useRef("");
  const charCountRef = useRef(0);
  const scrollCoolDownRef = useRef(0);

  const [loading, setLoading] = useState(false);
  const [edgeHint, setEdgeHint] = useState<"up" | "down" | null>(null);
  const [query, setQuery] = useState("");
  const [charCount, setCharCount] = useState(0);
  const [baseOffset, setBaseOffset] = useState(0);
  const [segment, setSegment] = useState("");
  const [hits, setHits] = useState<PreviewSearchHit[]>([]);
  const [hitTotal, setHitTotal] = useState(0);
  const [pageOffset, setPageOffset] = useState(0);
  const [localIndex, setLocalIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [activeQuery, setActiveQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [annotations, setAnnotations] = useState<EntryAnnotation[]>([]);
  const [activeAnnId, setActiveAnnId] = useState<number | null>(null);
  const [pendingSel, setPendingSel] = useState<PendingSel | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [draftColor, setDraftColor] = useState<string>(DEFAULT_COLOR);
  const [draftSel, setDraftSel] = useState<{ start: number; end: number; quote: string } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editAnn, setEditAnn] = useState<EntryAnnotation | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editColor, setEditColor] = useState(DEFAULT_COLOR);
  const [fontSize, setFontSize] = useState(() => readStoredFontSize());
  const [fontWeight, setFontWeight] = useState(() => readStoredFontWeight());

  const notesEnabled = entryId != null && entryId > 0;
  const globalIndex = localIndex >= 0 ? pageOffset + localIndex : -1;
  const pendingSelRef = useRef<PendingSel | null>(null);
  pendingSelRef.current = pendingSel;
  const draftOpenRef = useRef(false);
  draftOpenRef.current = draftOpen;
  const ignoreDismissUntilRef = useRef(0);

  function clearPendingSel() {
    setPendingSel(null);
    window.getSelection()?.removeAllRanges();
  }

  function dismissPendingIfIdle() {
    if (!pendingSelRef.current) return;
    if (draftOpenRef.current) return;
    if (Date.now() < ignoreDismissUntilRef.current) return;
    clearPendingSel();
  }

  function changeFontSize(size: number) {
    setFontSize(size);
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(size));
    } catch {
      /* ignore */
    }
  }

  function changeFontWeight(weight: number) {
    setFontWeight(weight);
    try {
      localStorage.setItem(FONT_WEIGHT_KEY, String(weight));
    } catch {
      /* ignore */
    }
  }

  async function refreshAnnotations() {
    if (!notesEnabled || entryId == null) {
      setAnnotations([]);
      return;
    }
    const res = await api.listAnnotations(entryId);
    setAnnotations(res.items);
  }

  function updatePageByScroll() {
    const el = bodyRef.current;
    const segLen = Math.max(1, segmentRef.current.length);
    const maxScroll = Math.max(1, (el?.scrollHeight ?? 1) - (el?.clientHeight ?? 0));
    const ratio = el ? Math.min(1, Math.max(0, el.scrollTop / maxScroll)) : 0;
    const viewPos = baseOffsetRef.current + ratio * segLen;
    const info = calcPageInfo(viewPos, charCountRef.current);
    setCurrentPage(info.currentPage);
    setTotalPages(info.totalPages);
  }

  function syncSegment(text: string, offset: number, total: number) {
    segmentRef.current = text;
    baseOffsetRef.current = offset;
    charCountRef.current = total;
    setSegment(text);
    setBaseOffset(offset);
    setCharCount(total);
    const info = calcPageInfo(offset, total);
    setCurrentPage(info.currentPage);
    setTotalPages(info.totalPages);
  }

  function getViewportAnchorChar(edge: "top" | "bottom" = "top") {
    const el = bodyRef.current;
    const oldBase = baseOffsetRef.current;
    const oldLen = Math.max(1, segmentRef.current.length);
    if (!el) return oldBase;
    const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
    const topRatio = Math.min(1, Math.max(0, el.scrollTop / maxScroll));
    if (edge === "bottom") {
      const visibleRatio = el.clientHeight / Math.max(1, el.scrollHeight);
      return oldBase + Math.min(oldLen, (topRatio + visibleRatio) * oldLen);
    }
    return oldBase + topRatio * oldLen;
  }

  function scrollToAnchorChar(
    el: HTMLDivElement,
    textLen: number,
    segOffset: number,
    anchorChar: number,
  ) {
    const rel = anchorChar - segOffset;
    const ratio = Math.min(1, Math.max(0, rel / Math.max(1, textLen)));
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(maxScroll, Math.max(0, ratio * maxScroll - 36));
  }

  async function loadAt(
    offset: number,
    options?: {
      highlightOffset?: number;
      highlightQuery?: string;
      preserve?: "anchor" | "top" | "none";
      anchorChar?: number;
      annId?: number;
    },
  ) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const start = Math.max(0, offset);
      const res = await loadSegment(start, WINDOW);
      syncSegment(res.text, res.offset, res.char_count);
      if (options?.highlightQuery != null) setActiveQuery(options.highlightQuery);
      if (options?.annId != null) setActiveAnnId(options.annId);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = bodyRef.current;
          if (!el) return;

          if (options?.annId != null) {
            const mark = el.querySelector(
              `mark[data-ann-id="${options.annId}"]`,
            ) as HTMLElement | null;
            mark?.scrollIntoView({ block: "center", behavior: "smooth" });
            updatePageByScroll();
            return;
          }

          if (options?.highlightOffset != null) {
            const mark = el.querySelector(
              `mark[data-abs="${options.highlightOffset}"]`,
            ) as HTMLElement | null;
            mark?.scrollIntoView({ block: "center", behavior: "smooth" });
            updatePageByScroll();
            return;
          }

          if (options?.preserve === "anchor" && options.anchorChar != null) {
            scrollToAnchorChar(el, res.text.length, res.offset, options.anchorChar);
            updatePageByScroll();
            return;
          }

          if (options?.preserve !== "none") {
            el.scrollTop = 0;
          }
          updatePageByScroll();
        });
      });
    } catch (err) {
      message.error(formatError(err, "加载预览失败"));
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setEdgeHint(null);
      scrollCoolDownRef.current = Date.now() + 360;
    }
  }

  async function loadMoreDown() {
    const end = baseOffsetRef.current + segmentRef.current.length;
    if (end >= charCountRef.current || loadingRef.current) return;
    const nextStart = Math.max(0, end - OVERLAP);
    if (nextStart <= baseOffsetRef.current) return;
    const anchorChar = getViewportAnchorChar("bottom");
    setEdgeHint("down");
    await loadAt(nextStart, { preserve: "anchor", anchorChar });
  }

  async function loadMoreUp() {
    if (baseOffsetRef.current <= 0 || loadingRef.current) return;
    const prevStart = Math.max(0, baseOffsetRef.current - (WINDOW - OVERLAP));
    if (prevStart >= baseOffsetRef.current) return;
    const anchorChar = getViewportAnchorChar("top");
    setEdgeHint("up");
    await loadAt(prevStart, { preserve: "anchor", anchorChar });
  }

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setHitTotal(0);
    setPageOffset(0);
    setLocalIndex(-1);
    setActiveQuery("");
    setEdgeHint(null);
    setPendingSel(null);
    setDraftOpen(false);
    setDraftSel(null);
    setActiveAnnId(null);
    void loadAt(0, { preserve: "top" });
    if (notesEnabled) {
      void refreshAnnotations().catch((err) => {
        message.error(formatError(err, "加载笔记失败"));
      });
    } else {
      setAnnotations([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entryId]);

  useEffect(() => {
    if (!pendingSel || draftOpen) return;
    function onDocPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-sel-popup]")) return;
      dismissPendingIfIdle();
    }
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSel, draftOpen]);

  function onBodyScroll() {
    dismissPendingIfIdle();
    updatePageByScroll();
    const el = bodyRef.current;
    if (!el || loadingRef.current) return;
    if (Date.now() < scrollCoolDownRef.current) return;

    const nearTop = el.scrollTop <= SCROLL_EDGE;
    const nearBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_EDGE;

    if (nearBottom && baseOffsetRef.current + segmentRef.current.length < charCountRef.current) {
      void loadMoreDown();
      return;
    }
    if (nearTop && baseOffsetRef.current > 0) {
      void loadMoreUp();
    }
  }

  function onBodyMouseUp(e: ReactMouseEvent) {
    if (!notesEnabled || !bodyRef.current) return;
    const target = e.target as HTMLElement;
    if (target.closest?.("[data-sel-popup]")) return;
    if (target.closest?.(`mark[data-ann-id]`)) return;

    const sel = getSelectionOffsets(bodyRef.current, baseOffsetRef.current);
    if (!sel) return;

    ignoreDismissUntilRef.current = Date.now() + 350;
    setPendingSel({
      x: sel.x || e.clientX,
      y: sel.y || e.clientY,
      start: sel.start,
      end: sel.end,
      quote: sel.quote,
      color: normalizeColor(pendingSelRef.current?.color),
    });
    // 用持久预览替代原生选区，避免点浮层时选区消失
    window.getSelection()?.removeAllRanges();
  }

  function onBodyClick(e: ReactMouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest?.("[data-sel-popup]")) return;
    const mark = target.closest?.("mark[data-ann-id]") as HTMLElement | null;
    if (!mark) {
      dismissPendingIfIdle();
      return;
    }
    const id = Number(mark.getAttribute("data-ann-id"));
    if (!id) return;
    const ann = annotations.find((a) => a.id === id);
    if (!ann) return;
    openAnnotationDetail(ann);
  }

  function openAnnotationDetail(ann: EntryAnnotation) {
    clearPendingSel();
    setActiveAnnId(ann.id);
    setEditAnn(ann);
    setEditNote(ann.note || "");
    setEditColor(normalizeColor(ann.color));
    setEditOpen(true);
  }

  function setPendingColor(color: string) {
    setPendingSel((prev) => (prev ? { ...prev, color: normalizeColor(color) } : prev));
  }

  function openNoteDraft() {
    if (!pendingSel) return;
    setDraftSel({ start: pendingSel.start, end: pendingSel.end, quote: pendingSel.quote });
    setDraftNote("");
    setDraftColor(normalizeColor(pendingSel.color));
    setDraftOpen(true);
  }

  async function confirmHighlight() {
    if (!pendingSel) return;
    await saveAnnotation({
      start: pendingSel.start,
      end: pendingSel.end,
      quote: pendingSel.quote,
      note: "",
      color: normalizeColor(pendingSel.color),
    });
  }

  function renderColorPicker(
    value: string,
    onChange: (hex: string) => void,
    compact = false,
  ) {
    const current = normalizeColor(value);
    return (
      <div className={compact ? styles.selColors : styles.colorRow}>
        {PRESET_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            title={c.label}
            className={`${compact ? styles.selColorDot : styles.colorBtn}${
              current === c.id ? ` ${compact ? styles.selColorActive : styles.colorBtnActive}` : ""
            }`}
            style={
              compact
                ? { background: c.id }
                : { background: c.id, color: "#fff" }
            }
            onClick={() => onChange(c.id)}
          >
            {compact ? null : c.label}
          </button>
        ))}
        <label
          className={compact ? styles.selColorCustom : styles.colorCustom}
          title="自选颜色"
        >
          <input
            type="color"
            value={current}
            onChange={(e) => onChange(normalizeColor(e.target.value))}
            aria-label="自选颜色"
          />
          {compact ? null : <span>自选</span>}
        </label>
      </div>
    );
  }

  async function saveAnnotation(payload: {
    start: number;
    end: number;
    quote: string;
    note: string;
    color: string;
  }) {
    if (!notesEnabled || entryId == null) return;
    setSaving(true);
    try {
      await api.createAnnotation(entryId, {
        start_offset: payload.start,
        end_offset: payload.end,
        quote: payload.quote,
        note: payload.note,
        color: normalizeColor(payload.color),
      });
      await refreshAnnotations();
      message.success(payload.note ? "笔记已保存" : "已高亮");
      setDraftOpen(false);
      setDraftSel(null);
      clearPendingSel();
    } catch (err) {
      message.error(formatError(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit() {
    if (!editAnn) return;
    setSaving(true);
    try {
      await api.updateAnnotation(editAnn.id, {
        note: editNote,
        color: normalizeColor(editColor),
      });
      await refreshAnnotations();
      message.success("已更新");
      setEditOpen(false);
      setEditAnn(null);
    } catch (err) {
      message.error(formatError(err, "更新失败"));
    } finally {
      setSaving(false);
    }
  }

  async function removeAnn(id: number) {
    try {
      await api.deleteAnnotation(id);
      await refreshAnnotations();
      if (activeAnnId === id) setActiveAnnId(null);
      setEditOpen(false);
      setEditAnn(null);
      message.success("已删除");
    } catch (err) {
      message.error(formatError(err, "删除失败"));
    }
  }

  async function jumpToAnnotation(ann: EntryAnnotation) {
    setActiveAnnId(ann.id);
    const windowStart = Math.max(0, ann.start_offset - PAD);
    if (
      ann.start_offset >= baseOffsetRef.current &&
      ann.end_offset <= baseOffsetRef.current + segmentRef.current.length
    ) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          const mark = bodyRef.current?.querySelector(
            `mark[data-ann-id="${ann.id}"]`,
          ) as HTMLElement | null;
          mark?.scrollIntoView({ block: "center", behavior: "smooth" });
          resolve();
        });
      });
      return;
    }
    await loadAt(windowStart, { annId: ann.id, preserve: "none" });
  }

  async function focusAnnotation(ann: EntryAnnotation) {
    await jumpToAnnotation(ann);
    openAnnotationDetail(ann);
  }

  async function fetchHitPage(q: string, offset: number) {
    const res = await searchAll(q, { offset, limit: PAGE_SIZE });
    setHits(res.hits);
    setHitTotal(res.total);
    setPageOffset(res.offset);
    setActiveQuery(q);
    return res;
  }

  async function jumpToHit(hit: PreviewSearchHit, indexInPage: number, q: string = activeQuery) {
    setLocalIndex(indexInPage);
    const windowStart = Math.max(0, hit.offset - PAD);
    if (
      hit.offset >= baseOffsetRef.current &&
      hit.offset + hit.length <= baseOffsetRef.current + segmentRef.current.length
    ) {
      setActiveQuery(q);
      requestAnimationFrame(() => {
        const mark = bodyRef.current?.querySelector(
          `mark[data-abs="${hit.offset}"]`,
        ) as HTMLElement | null;
        mark?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      return;
    }
    await loadAt(windowStart, {
      highlightOffset: hit.offset,
      highlightQuery: q,
      preserve: "none",
    });
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) {
      message.info("请输入要搜索的内容");
      return;
    }
    setSearching(true);
    try {
      const res = await fetchHitPage(q, 0);
      if (!res.hits.length) {
        setLocalIndex(-1);
        message.info("未找到匹配内容");
        return;
      }
      await jumpToHit(res.hits[0], 0, q);
    } catch (err) {
      message.error(formatError(err, "搜索失败"));
    } finally {
      setSearching(false);
    }
  }

  async function goHit(delta: number) {
    if (!activeQuery || hitTotal <= 0) return;
    let nextGlobal = globalIndex + delta;
    if (nextGlobal < 0) nextGlobal = hitTotal - 1;
    if (nextGlobal >= hitTotal) nextGlobal = 0;

    if (nextGlobal >= pageOffset && nextGlobal < pageOffset + hits.length) {
      const idx = nextGlobal - pageOffset;
      await jumpToHit(hits[idx], idx);
      return;
    }

    setSearching(true);
    try {
      const pageStart = Math.floor(nextGlobal / PAGE_SIZE) * PAGE_SIZE;
      const res = await fetchHitPage(activeQuery, pageStart);
      if (!res.hits.length) return;
      const idx = Math.min(nextGlobal - res.offset, res.hits.length - 1);
      await jumpToHit(res.hits[Math.max(0, idx)], Math.max(0, idx));
    } catch (err) {
      message.error(formatError(err, "加载更多命中失败"));
    } finally {
      setSearching(false);
    }
  }

  const html = buildHighlightedHtml(
    segment,
    baseOffset,
    activeQuery,
    localIndex >= 0 && hits[localIndex] ? hits[localIndex].offset : null,
    annotations,
    activeAnnId,
    pendingSel,
  );

  const endPos = baseOffset + segment.length;
  const listStart = pageOffset;
  const showHits = hits.slice(0, 12);
  const canUp = baseOffset > 0;
  const canDown = endPos < charCount;

  return (
    <>
      <Modal
        title={title || "正文预览"}
        open={open}
        onCancel={onClose}
        width={notesEnabled ? 980 : 820}
        destroyOnHidden
        footer={
          <Space wrap>
            <Typography.Text type="secondary" className={styles.scrollTip}>
              {notesEnabled ? "划选后选色并确认高亮 · " : ""}
              滚到顶部/底部可自动加载
            </Typography.Text>
            <Button type="primary" onClick={onClose}>
              关闭
            </Button>
          </Space>
        }
      >
        <div className={styles.toolbar}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索正文并跳转定位"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPressEnter={() => void runSearch()}
            className={styles.searchInput}
          />
          <Button type="primary" loading={searching} onClick={() => void runSearch()}>
            搜索
          </Button>
          <div className={styles.hitNav}>
            <Button
              type="text"
              size="small"
              className={styles.hitNavBtn}
              icon={<ArrowUpOutlined />}
              disabled={!hitTotal}
              loading={searching}
              onClick={() => void goHit(-1)}
              aria-label="上一个"
            />
            <Button
              type="text"
              size="small"
              className={styles.hitNavBtn}
              icon={<ArrowDownOutlined />}
              disabled={!hitTotal}
              loading={searching}
              onClick={() => void goHit(1)}
              aria-label="下一个"
            />
          </div>
          <Typography.Text type="secondary" className={styles.hitMeta}>
            {hitTotal > 0 && globalIndex >= 0
              ? `${globalIndex + 1} / ${hitTotal}`
              : activeQuery
                ? "无匹配"
                : ""}
          </Typography.Text>
          <div className={styles.fontControls}>
            <Select
              size="small"
              value={fontSize}
              className={styles.fontSelect}
              options={FONT_SIZE_OPTIONS.map((n) => ({ value: n, label: `${n}px` }))}
              onChange={(v) => changeFontSize(Number(v))}
              aria-label="字号"
            />
            <Select
              size="small"
              value={fontWeight}
              className={styles.fontSelect}
              options={FONT_WEIGHT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(v) => changeFontWeight(Number(v))}
              aria-label="字重"
            />
          </div>
        </div>

        <Typography.Paragraph type="secondary" className={styles.meta}>
          <span className={styles.pageBadge}>
            第 {currentPage} / {totalPages} 页
          </span>
          共 {charCount.toLocaleString()} 字
          {notesEnabled ? ` · 笔记 ${annotations.length}` : ""}
          {loading ? " · 加载中…" : ""}
        </Typography.Paragraph>

        <div className={notesEnabled ? styles.mainSplit : undefined}>
          <div className={styles.bodyWrap}>
            {canUp ? (
              <div
                className={`${styles.edgeHint}${edgeHint === "up" ? ` ${styles.edgeActive}` : ""}`}
              >
                {loading && edgeHint === "up" ? "正在加载上文…" : "↑ 继续上滑加载上文"}
              </div>
            ) : (
              <div className={styles.edgeHint}>已到第一页</div>
            )}
            <div
              ref={bodyRef}
              className={styles.body}
              style={{ fontSize: `${fontSize}px`, fontWeight }}
              onScroll={onBodyScroll}
              onMouseUp={onBodyMouseUp}
              onClick={onBodyClick}
              dangerouslySetInnerHTML={{ __html: html || "暂无正文" }}
            />
            {canDown ? (
              <div
                className={`${styles.edgeHint}${edgeHint === "down" ? ` ${styles.edgeActive}` : ""}`}
              >
                {loading && edgeHint === "down" ? "正在加载下文…" : "↓ 继续下滑加载下文"}
              </div>
            ) : (
              <div className={styles.edgeHint}>已到最后一页</div>
            )}
          </div>

          {notesEnabled && (
            <aside className={styles.notePane} onScroll={dismissPendingIfIdle}>
              <div className={styles.notePaneHead}>
                <HighlightOutlined /> 笔记 ({annotations.length})
              </div>
              {annotations.length === 0 ? (
                <p className={styles.noteEmpty}>划选正文即可添加高亮或笔记</p>
              ) : (
                <ul className={styles.noteList}>
                  {annotations.map((ann) => (
                    <li key={ann.id}>
                      <button
                        type="button"
                        className={`${styles.noteItem}${
                          activeAnnId === ann.id ? ` ${styles.noteItemActive}` : ""
                        }`}
                        onClick={() => void focusAnnotation(ann)}
                      >
                        <span
                          className={styles.noteDot}
                          style={{ background: normalizeColor(ann.color) }}
                        />
                        <div className={styles.noteBody}>
                          <strong>{ann.quote.slice(0, 48)}{ann.quote.length > 48 ? "…" : ""}</strong>
                          {ann.note ? <p>{ann.note}</p> : <p className={styles.noteMuted}>仅高亮</p>}
                          <em>{formatTime(ann.created_at)}</em>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}
        </div>

        {hits.length > 0 && (
          <div className={styles.hitList}>
            {showHits.map((hit, i) => {
              const global = listStart + i;
              return (
                <button
                  key={`${hit.offset}-${global}`}
                  type="button"
                  className={`${styles.hitItem}${
                    global === globalIndex ? ` ${styles.hitItemActive}` : ""
                  }`}
                  onClick={() => void jumpToHit(hit, i)}
                >
                  <span>#{global + 1}</span>
                  <em>{hit.snippet}</em>
                </button>
              );
            })}
          </div>
        )}
      </Modal>

      {pendingSel && (
        <div
          className={styles.selPopup}
          data-sel-popup="1"
          style={{ left: pendingSel.x, top: Math.max(12, pendingSel.y - 8) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <span className={styles.selPopupLabel}>颜色</span>
          {renderColorPicker(pendingSel.color, setPendingColor, true)}
          <Button
            size="small"
            type="primary"
            loading={saving && !draftOpen}
            onClick={() => void confirmHighlight()}
          >
            确认高亮
          </Button>
          <Button size="small" onClick={openNoteDraft}>
            写笔记
          </Button>
          <Button size="small" type="text" onClick={clearPendingSel}>
            取消
          </Button>
        </div>
      )}

      <Modal
        title="写笔记"
        open={draftOpen}
        onCancel={() => {
          setDraftOpen(false);
          setDraftSel(null);
          // 取消写笔记时仍保留划选预览，可改色或确认高亮
        }}
        onOk={() => {
          if (!draftSel) return;
          void saveAnnotation({
            start: draftSel.start,
            end: draftSel.end,
            quote: draftSel.quote,
            note: draftNote,
            color: normalizeColor(draftColor),
          });
        }}
        confirmLoading={saving}
        okText="保存"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" className={styles.quoteBox}>
          {draftSel?.quote}
        </Typography.Paragraph>
        {renderColorPicker(draftColor, (hex) => {
          setDraftColor(hex);
          setPendingColor(hex);
        })}
        <Input.TextArea
          rows={4}
          value={draftNote}
          onChange={(e) => setDraftNote(e.target.value)}
          placeholder="写下你的批注（可空，仅高亮）"
          maxLength={2000}
        />
      </Modal>

      <Modal
        title="笔记详情"
        open={editOpen}
        onCancel={() => {
          setEditOpen(false);
          setEditAnn(null);
        }}
        footer={
          <Space>
            <Popconfirm title="确定删除这条笔记？" onConfirm={() => editAnn && void removeAnn(editAnn.id)}>
              <Button danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
            <Button onClick={() => setEditOpen(false)}>取消</Button>
            <Button type="primary" icon={<EditOutlined />} loading={saving} onClick={() => void saveEdit()}>
              保存
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" className={styles.quoteBox}>
          {editAnn?.quote}
        </Typography.Paragraph>
        {renderColorPicker(editColor, setEditColor)}
        <Input.TextArea
          rows={4}
          value={editNote}
          onChange={(e) => setEditNote(e.target.value)}
          placeholder="批注内容"
          maxLength={2000}
        />
      </Modal>
    </>
  );
}
