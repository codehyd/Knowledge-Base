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
  /** 喂养来源 id；优先用于阅读进度键（比 entry 更稳定） */
  sourceId?: number | null;
};

const WINDOW = 10000;
const PAD = 1800;
const PAGE_SIZE = 100;
const PROGRESS_KEY_PREFIX = "kongku.preview.progress.";
const PROGRESS_SAVE_MS = 500;
/** 恢复滚动后短暂禁止写进度，避免未定位完成时把进度冲成更靠前的位置 */
const PROGRESS_RESUME_GUARD_MS = 900;

type StoredProgress = { offset: number; updatedAt: number };

function progressStorageKey(sourceId?: number | null, entryId?: number | null): string | null {
  if (sourceId != null && sourceId > 0) return `${PROGRESS_KEY_PREFIX}source:${sourceId}`;
  if (entryId != null && entryId > 0) return `${PROGRESS_KEY_PREFIX}entry:${entryId}`;
  return null;
}

function readStoredProgress(key: string | null): number {
  if (!key) return 0;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as StoredProgress;
    const offset = Number(parsed?.offset);
    return Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  } catch {
    return 0;
  }
}

function writeStoredProgress(key: string | null, offset: number) {
  if (!key) return;
  const pos = Math.max(0, Math.floor(offset));
  try {
    const payload: StoredProgress = { offset: pos, updatedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    /* ignore quota / private mode */
  }
}

/** 按正文相对字符偏移滚动；比「整段比例估算」更接近真实阅读位置 */
function scrollToTextOffset(
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

function applyAnchorScroll(
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
  sourceId = null,
}: Props) {
  const { message } = App.useApp();
  const bodyRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const baseOffsetRef = useRef(0);
  const segmentRef = useRef("");
  const charCountRef = useRef(0);
  const scrollCoolDownRef = useRef(0);
  const progressKeyRef = useRef<string | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const lastProgressRef = useRef(0);
  const suppressProgressRef = useRef(false);
  const resumeGuardTimerRef = useRef<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [resumedHint, setResumedHint] = useState(false);
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

  function flushProgress(pos?: number) {
    if (suppressProgressRef.current && pos == null) return;
    const key = progressKeyRef.current;
    if (!key) return;
    let anchor: number;
    if (pos != null && Number.isFinite(pos)) {
      anchor = pos;
    } else if (bodyRef.current) {
      anchor = getViewportAnchorChar("top");
    } else {
      anchor = lastProgressRef.current;
    }
    const total = charCountRef.current;
    const clamped =
      total > 0 ? Math.min(Math.max(0, Math.floor(anchor)), Math.max(0, total - 1)) : 0;
    lastProgressRef.current = clamped;
    writeStoredProgress(key, clamped);
  }

  function scheduleProgressSave() {
    if (suppressProgressRef.current || !progressKeyRef.current) return;
    if (bodyRef.current) {
      lastProgressRef.current = getViewportAnchorChar("top");
    }
    if (progressTimerRef.current != null) {
      window.clearTimeout(progressTimerRef.current);
    }
    progressTimerRef.current = window.setTimeout(() => {
      progressTimerRef.current = null;
      flushProgress(lastProgressRef.current);
    }, PROGRESS_SAVE_MS);
  }

  function beginResumeGuard() {
    suppressProgressRef.current = true;
    if (resumeGuardTimerRef.current != null) {
      window.clearTimeout(resumeGuardTimerRef.current);
    }
    resumeGuardTimerRef.current = window.setTimeout(() => {
      resumeGuardTimerRef.current = null;
      suppressProgressRef.current = false;
    }, PROGRESS_RESUME_GUARD_MS);
  }

  function handleClose() {
    if (progressTimerRef.current != null) {
      window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    suppressProgressRef.current = false;
    flushProgress();
    onClose();
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

  function getViewportAnchorChar(edge: "top" | "mid" | "bottom" = "mid") {
    const el = bodyRef.current;
    const oldBase = baseOffsetRef.current;
    const oldLen = Math.max(1, segmentRef.current.length);
    if (!el) return oldBase;
    const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
    const topRatio = Math.min(1, Math.max(0, el.scrollTop / maxScroll));
    const visibleRatio = el.clientHeight / Math.max(1, el.scrollHeight);
    if (edge === "bottom") {
      return oldBase + Math.min(oldLen, (topRatio + visibleRatio) * oldLen);
    }
    if (edge === "mid") {
      return oldBase + Math.min(oldLen, (topRatio + visibleRatio * 0.45) * oldLen);
    }
    return oldBase + topRatio * oldLen;
  }

  function scrollToAnchorChar(
    el: HTMLDivElement,
    textLen: number,
    segOffset: number,
    anchorChar: number,
  ) {
    applyAnchorScroll(el, textLen, segOffset, anchorChar);
  }

  function settleAnchorScroll(
    el: HTMLDivElement,
    textLen: number,
    segOffset: number,
    anchorChar: number,
  ) {
    const run = () => applyAnchorScroll(el, textLen, segOffset, anchorChar);
    run();
    requestAnimationFrame(() => {
      run();
      window.setTimeout(run, 40);
      window.setTimeout(() => {
        run();
        updatePageByScroll();
        // 固定为恢复目标，避免测量误差把进度往前推
        lastProgressRef.current = anchorChar;
      }, 120);
    });
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
            settleAnchorScroll(el, res.text.length, res.offset, options.anchorChar);
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
    const key = progressStorageKey(sourceId, entryId);
    progressKeyRef.current = key;
    setResumedHint(false);
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

    const saved = readStoredProgress(key);
    lastProgressRef.current = saved;
    if (saved > 0) {
      beginResumeGuard();
      // 让目标落在窗口前半段，便于精确定位到视口顶部附近
      const windowStart = Math.max(0, saved - Math.floor(WINDOW / 4));
      setResumedHint(true);
      void loadAt(windowStart, { preserve: "anchor", anchorChar: saved });
      window.setTimeout(() => setResumedHint(false), 3200);
    } else {
      suppressProgressRef.current = false;
      void loadAt(0, { preserve: "top" });
    }

    if (notesEnabled) {
      void refreshAnnotations().catch((err) => {
        message.error(formatError(err, "加载笔记失败"));
      });
    } else {
      setAnnotations([]);
    }

    return () => {
      if (progressTimerRef.current != null) {
        window.clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }
      if (resumeGuardTimerRef.current != null) {
        window.clearTimeout(resumeGuardTimerRef.current);
        resumeGuardTimerRef.current = null;
      }
      // 恢复过程中不写回，避免把进度冲到更靠前
      if (!suppressProgressRef.current) {
        flushProgress();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entryId, sourceId]);

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
    scheduleProgressSave();
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
        onCancel={handleClose}
        width={notesEnabled ? 980 : 820}
        destroyOnHidden
        footer={
          <Space wrap>
            <Typography.Text type="secondary" className={styles.scrollTip}>
              {notesEnabled ? "划选后选色并确认高亮 · " : ""}
              滚到顶部/底部可自动加载
              {progressKeyRef.current ? " · 自动记住阅读位置" : ""}
            </Typography.Text>
            <Button type="primary" onClick={handleClose}>
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
          {resumedHint ? " · 已回到上次阅读位置" : ""}
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

      {pendingSel && !draftOpen && (
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
