import { useRef, useState } from "react";
import type { MessageInstance } from "antd/es/message/interface";
import { formatError } from "@/shared/ui/feedback";
import { applyAnchorScroll } from "./previewOffsets";
import {
  calcPageInfo,
  progressStorageKey,
  PROGRESS_SAVE_MS,
  PROGRESS_RESUME_GUARD_MS,
  readStoredProgress,
  writeStoredProgress,
} from "./previewProgress";

export const WINDOW = 10000;
export const PAD = 1800;
export const OVERLAP = 1200;
export const SCROLL_EDGE = 72;

type LoadSegment = (offset: number, limit: number) => Promise<{
  text: string;
  char_count: number;
  offset: number;
  truncated: boolean;
}>;

export type LoadAtOptions = {
  highlightOffset?: number;
  highlightQuery?: string;
  preserve?: "anchor" | "top" | "none";
  anchorChar?: number;
  annId?: number;
};

type LoaderCallbacks = {
  setActiveQuery?: (query: string) => void;
  setActiveAnnId?: (id: number) => void;
};

export function usePreviewLoader(
  loadSegment: LoadSegment,
  message: MessageInstance,
  sourceId?: number | null,
  entryId?: number | null,
  callbacks?: LoaderCallbacks,
) {
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
  const [charCount, setCharCount] = useState(0);
  const [baseOffset, setBaseOffset] = useState(0);
  const [segment, setSegment] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

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

  async function loadAt(offset: number, options?: LoadAtOptions) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const start = Math.max(0, offset);
      const res = await loadSegment(start, WINDOW);
      syncSegment(res.text, res.offset, res.char_count);
      if (options?.highlightQuery != null) callbacks?.setActiveQuery?.(options.highlightQuery);
      if (options?.annId != null) callbacks?.setActiveAnnId?.(options.annId);

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
            if (mark) {
              mark.scrollIntoView({ block: "center", behavior: "smooth" });
              updatePageByScroll();
              return;
            }
            if (options.anchorChar != null) {
              settleAnchorScroll(el, res.text.length, res.offset, options.anchorChar);
              return;
            }
            settleAnchorScroll(el, res.text.length, res.offset, options.highlightOffset);
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

      return options;
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

  function initProgressKey() {
    const key = progressStorageKey(sourceId, entryId);
    progressKeyRef.current = key;
    return key;
  }

  function handleClose(onClose: () => void) {
    if (progressTimerRef.current != null) {
      window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    suppressProgressRef.current = false;
    flushProgress();
    onClose();
  }

  function cleanupProgress() {
    if (progressTimerRef.current != null) {
      window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    if (resumeGuardTimerRef.current != null) {
      window.clearTimeout(resumeGuardTimerRef.current);
      resumeGuardTimerRef.current = null;
    }
    if (!suppressProgressRef.current) {
      flushProgress();
    }
  }

  function onBodyScroll(onDismiss?: () => void) {
    onDismiss?.();
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

  function restoreSavedProgress() {
    const key = initProgressKey();
    const saved = readStoredProgress(key);
    lastProgressRef.current = saved;
    if (saved > 0) {
      beginResumeGuard();
      const windowStart = Math.max(0, saved - Math.floor(WINDOW / 4));
      setResumedHint(true);
      void loadAt(windowStart, { preserve: "anchor", anchorChar: saved });
      window.setTimeout(() => setResumedHint(false), 3200);
      return true;
    }
    suppressProgressRef.current = false;
    void loadAt(0, { preserve: "top" });
    return false;
  }

  return {
    bodyRef,
    loadingRef,
    baseOffsetRef,
    segmentRef,
    charCountRef,
    scrollCoolDownRef,
    progressKeyRef,
    progressTimerRef,
    lastProgressRef,
    suppressProgressRef,
    resumeGuardTimerRef,
    loading,
    resumedHint,
    edgeHint,
    charCount,
    baseOffset,
    segment,
    currentPage,
    totalPages,
    setResumedHint,
    setEdgeHint,
    loadAt,
    loadMoreDown,
    loadMoreUp,
    syncSegment,
    updatePageByScroll,
    getViewportAnchorChar,
    flushProgress,
    scheduleProgressSave,
    beginResumeGuard,
    initProgressKey,
    handleClose,
    cleanupProgress,
    onBodyScroll,
    restoreSavedProgress,
  };
}
