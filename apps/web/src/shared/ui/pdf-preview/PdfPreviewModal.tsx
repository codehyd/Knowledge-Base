import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ColumnWidthOutlined,
  CompressOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  HighlightOutlined,
  LeftOutlined,
  RightOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import { App, Button, Input, InputNumber, Modal, Popconfirm, Space, Spin, Switch, Typography } from "antd";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  api,
  type AnnotationRect,
  type EntryAnnotation,
} from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import {
  DEFAULT_COLOR,
  normalizeColor,
  PRESET_COLORS,
} from "@/shared/ui/text-preview/previewHighlight";
import {
  PDF_PAGE_SAVE_MS,
  pdfPageStorageKey,
  readStoredPdfPage,
  writeStoredPdfPage,
} from "./pdfPageProgress";
import styles from "./PdfPreviewModal.module.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const STAGE_PAD = 24;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

type FitMode = "width" | "page";

type Props = {
  open: boolean;
  title: string;
  sourceId: number | null;
  entryId?: number | null;
  onClose: () => void;
  onOpenTextPreview?: () => void;
};

type DraftRect = AnnotationRect & { page: number };

function parseRect(raw?: string | null): AnnotationRect | null {
  if (!raw?.trim()) return null;
  try {
    const data = JSON.parse(raw) as Partial<AnnotationRect>;
    const x = Number(data.x);
    const y = Number(data.y);
    const w = Number(data.w);
    const h = Number(data.h);
    if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
    if (w < 0.005 || h < 0.005) return null;
    return { x, y, w, h };
  } catch {
    return null;
  }
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  const current = normalizeColor(value);
  return (
    <div className={styles.colorRow}>
      {PRESET_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          title={c.label}
          className={`${styles.colorBtn}${current === c.id ? ` ${styles.colorBtnActive}` : ""}`}
          style={{ background: c.id }}
          onClick={() => onChange(c.id)}
        >
          {c.label}
        </button>
      ))}
      <label className={styles.colorCustom} title="自选颜色">
        <input
          type="color"
          value={current}
          onChange={(e) => onChange(normalizeColor(e.target.value))}
          aria-label="自选颜色"
        />
        <span>自选</span>
      </label>
    </div>
  );
}

function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function PdfPreviewModal({
  open,
  title,
  sourceId,
  entryId = null,
  onClose,
  onOpenTextPreview,
}: Props) {
  const { message } = App.useApp();
  const canAnnotate = entryId != null && entryId > 0;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageBoxRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pdfDocRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const pageRef = useRef(1);
  const pageCountRef = useRef(0);
  const pendingScrollRef = useRef<"top" | "bottom" | null>(null);
  const wheelLockRef = useRef(0);
  const pageAnimTimerRef = useRef(0);
  const skipFadeOnceRef = useRef(true);
  const progressKeyRef = useRef<string | null>(null);
  const progressTimerRef = useRef(0);
  const suppressProgressRef = useRef(false);

  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [resumedHint, setResumedHint] = useState(false);
  /** 相对适应比例的缩放倍数 */
  const [zoom, setZoom] = useState(1);
  /** 默认适宽：像普通 PDF 一样纵向滚动阅读 */
  const [fitMode, setFitMode] = useState<FitMode>("width");
  const [fitScale, setFitScale] = useState(1);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [pageSize, setPageSize] = useState({ w: 0, h: 0 });
  /** 默认关闭：纯阅读，不显示高亮/笔记侧栏 */
  const [noteMode, setNoteMode] = useState(false);
  const [annotations, setAnnotations] = useState<EntryAnnotation[]>([]);
  const [activeAnnId, setActiveAnnId] = useState<number | null>(null);
  const [draftRect, setDraftRect] = useState<DraftRect | null>(null);
  const [drawing, setDrawing] = useState<AnnotationRect | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [draftColor, setDraftColor] = useState(DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editAnn, setEditAnn] = useState<EntryAnnotation | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editColor, setEditColor] = useState(DEFAULT_COLOR);
  /** 单层淡入，避免叠层翻页库造成的重影 */
  const [pageFading, setPageFading] = useState(false);
  /** 鼠标靠近左/右侧翻页区时的高亮 */
  const [hoverSide, setHoverSide] = useState<"prev" | "next" | null>(null);

  pageRef.current = page;
  pageCountRef.current = pageCount;

  const showNotesUi = noteMode && canAnnotate;

  const pageNotes = useMemo(
    () =>
      annotations
        .filter((a) => a.page != null && a.page > 0 && (a.kind || "note") !== "chat_anchor")
        .sort((a, b) => (a.page || 0) - (b.page || 0) || a.id - b.id),
    [annotations],
  );

  const marksOnPage = useMemo(
    () => pageNotes.filter((a) => a.page === page),
    [pageNotes, page],
  );

  const refreshAnnotations = useCallback(async () => {
    if (!canAnnotate || entryId == null) {
      setAnnotations([]);
      return;
    }
    try {
      const res = await api.listAnnotations(entryId);
      setAnnotations(res.items);
    } catch (err) {
      message.error(formatError(err, "加载页内笔记失败"));
    }
  }, [entryId, message, canAnnotate]);

  const cleanupPdf = useCallback(async () => {
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    const doc = pdfDocRef.current;
    pdfDocRef.current = null;
    if (doc) {
      try {
        await doc.destroy();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const measureStage = useCallback(() => {
    const el = stageRef.current;
    if (!el) return { w: 0, h: 0 };
    const rect = el.getBoundingClientRect();
    return {
      w: Math.max(0, rect.width - STAGE_PAD),
      h: Math.max(0, rect.height - STAGE_PAD),
    };
  }, []);

  const computeFitScale = useCallback(
    async (pageNum: number, avail: { w: number; h: number }, mode: FitMode) => {
      const doc = pdfDocRef.current;
      if (!doc || avail.w < 40 || avail.h < 40) return 1;
      const pdfPage = await doc.getPage(pageNum);
      const base = pdfPage.getViewport({ scale: 1 });
      if (mode === "width") {
        return Math.max(0.2, avail.w / base.width);
      }
      const sx = avail.w / base.width;
      const sy = avail.h / base.height;
      return Math.max(0.2, Math.min(sx, sy));
    },
    [],
  );

  const triggerPageFade = useCallback(() => {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    window.clearTimeout(pageAnimTimerRef.current);
    setPageFading(true);
    pageAnimTimerRef.current = window.setTimeout(() => setPageFading(false), 220);
  }, []);

  const renderPage = useCallback(
    async (
      pageNum: number,
      nextZoom: number,
      avail: { w: number; h: number },
      mode: FitMode,
    ) => {
      const doc = pdfDocRef.current;
      const canvas = canvasRef.current;
      if (!doc || !canvas || avail.w < 40 || avail.h < 40) return;
      setRendering(true);
      try {
        renderTaskRef.current?.cancel();
        const nextFit = await computeFitScale(pageNum, avail, mode);
        setFitScale(nextFit);
        const cssScale = nextFit * nextZoom;
        const pdfPage = await doc.getPage(pageNum);
        const viewport = pdfPage.getViewport({ scale: cssScale });
        const dpr = Math.min(2.5, window.devicePixelRatio || 1);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setPageSize({ w: viewport.width, h: viewport.height });
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const task = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;

        const stage = stageRef.current;
        if (stage && pendingScrollRef.current) {
          const want = pendingScrollRef.current;
          pendingScrollRef.current = null;
          requestAnimationFrame(() => {
            if (want === "bottom") {
              stage.scrollTop = stage.scrollHeight;
            } else {
              stage.scrollTop = 0;
            }
          });
        }

        if (skipFadeOnceRef.current) {
          skipFadeOnceRef.current = false;
        } else {
          triggerPageFade();
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "RenderingCancelledException") return;
        message.error(formatError(err, "渲染 PDF 页失败"));
      } finally {
        setRendering(false);
      }
    },
    [computeFitScale, message, triggerPageFade],
  );

  const goPage = useCallback((next: number, scrollTo: "top" | "bottom" = "top") => {
    const total = pageCountRef.current;
    if (total < 1) return;
    const clamped = Math.max(1, Math.min(total, next));
    if (clamped === pageRef.current) {
      const stage = stageRef.current;
      if (stage) stage.scrollTop = scrollTo === "bottom" ? stage.scrollHeight : 0;
      return;
    }
    pendingScrollRef.current = scrollTo;
    setPage(clamped);
    setActiveAnnId(null);
  }, []);

  useEffect(() => {
    if (!open || sourceId == null) return;
    let cancelled = false;
    const progressKey = pdfPageStorageKey(sourceId, entryId);
    progressKeyRef.current = progressKey;
    suppressProgressRef.current = true;
    setLoading(true);
    setPage(1);
    setPageCount(0);
    setZoom(1);
    setFitMode("width");
    setNoteMode(false);
    setActiveAnnId(null);
    setDraftRect(null);
    setDrawing(null);
    setDraftOpen(false);
    setEditOpen(false);
    setPageFading(false);
    setResumedHint(false);
    window.clearTimeout(pageAnimTimerRef.current);
    window.clearTimeout(progressTimerRef.current);
    pendingScrollRef.current = "top";
    skipFadeOnceRef.current = true;

    (async () => {
      await cleanupPdf();
      try {
        const loadingTask = pdfjs.getDocument({
          url: api.sourceOriginalUrl(sourceId),
          withCredentials: false,
        });
        const doc = await loadingTask.promise;
        if (cancelled) {
          await doc.destroy();
          return;
        }
        pdfDocRef.current = doc;
        const total = doc.numPages;
        setPageCount(total);
        const saved = readStoredPdfPage(progressKey);
        const start = saved >= 1 && saved <= total ? saved : 1;
        setPage(start);
        if (start > 1) setResumedHint(true);
        await refreshAnnotations();
        requestAnimationFrame(() => {
          if (!cancelled) setStageSize(measureStage());
        });
        // 恢复页码后短暂禁止写进度，避免首帧把进度冲回 1
        window.setTimeout(() => {
          if (!cancelled) suppressProgressRef.current = false;
        }, 500);
      } catch (err) {
        if (!cancelled) message.error(formatError(err, "打开 PDF 失败"));
        suppressProgressRef.current = false;
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(pageAnimTimerRef.current);
      window.clearTimeout(progressTimerRef.current);
      // 关闭前落盘当前页
      if (progressKeyRef.current && pageRef.current >= 1) {
        writeStoredPdfPage(progressKeyRef.current, pageRef.current);
      }
      void cleanupPdf();
    };
  }, [open, sourceId, entryId, cleanupPdf, message, refreshAnnotations, measureStage]);

  useEffect(() => {
    if (!open || suppressProgressRef.current) return;
    if (page < 1 || !progressKeyRef.current) return;
    window.clearTimeout(progressTimerRef.current);
    progressTimerRef.current = window.setTimeout(() => {
      writeStoredPdfPage(progressKeyRef.current, page);
    }, PDF_PAGE_SAVE_MS);
    return () => window.clearTimeout(progressTimerRef.current);
  }, [open, page]);

  useEffect(() => {
    if (!resumedHint) return;
    const t = window.setTimeout(() => setResumedHint(false), 2600);
    return () => window.clearTimeout(t);
  }, [resumedHint]);

  useEffect(() => {
    if (!open) return;
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const avail = measureStage();
      setStageSize((prev) =>
        Math.abs(prev.w - avail.w) < 1 && Math.abs(prev.h - avail.h) < 1 ? prev : avail,
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, showNotesUi, measureStage]);

  useEffect(() => {
    if (!open || !pdfDocRef.current || page < 1 || stageSize.w < 40) return;
    void renderPage(page, zoom, stageSize, fitMode);
  }, [open, page, zoom, fitMode, pageCount, stageSize, renderPage]);

  // 键盘翻页（类微信读书）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (draftOpen || editOpen) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
        e.preventDefault();
        goPage(pageRef.current + 1, "top");
      } else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) {
        e.preventDefault();
        goPage(pageRef.current - 1, "bottom");
      } else if (e.key === "Home") {
        e.preventDefault();
        goPage(1, "top");
      } else if (e.key === "End") {
        e.preventDefault();
        goPage(pageCountRef.current, "top");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, draftOpen, editOpen, goPage]);

  // 滚轮：页内先滚，到顶/底再翻页（非 passive，才能拦截）
  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;

    const onWheel = (e: WheelEvent) => {
      if (noteMode && dragOriginRef.current) return;
      const now = Date.now();
      if (now < wheelLockRef.current) return;

      const delta = e.deltaY;
      if (Math.abs(delta) < 2) return;

      const atTop = stage.scrollTop <= 1;
      const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
      const canScroll = stage.scrollHeight > stage.clientHeight + 2;

      if (canScroll) {
        if (delta > 0 && !atBottom) return;
        if (delta < 0 && !atTop) return;
      }

      if (delta > 0 && pageRef.current < pageCountRef.current) {
        e.preventDefault();
        wheelLockRef.current = now + 280;
        goPage(pageRef.current + 1, "top");
      } else if (delta < 0 && pageRef.current > 1) {
        e.preventDefault();
        wheelLockRef.current = now + 280;
        goPage(pageRef.current - 1, "bottom");
      }
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [open, noteMode, goPage, showNotesUi, pageCount]);

  function bumpZoom(delta: number) {
    setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round((z + delta) * 100) / 100)));
  }

  function onEdgeClick(side: "prev" | "next") {
    if (noteMode) return;
    if (side === "prev") goPage(page - 1, "bottom");
    else goPage(page + 1, "top");
  }

  /** 阅读模式：点页面左侧上一页、右侧下一页（不依赖边缘热区叠层） */
  function onPageBoxClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (noteMode || showNotesUi) return;
    if (e.button !== 0) return;
    const box = pageBoxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (rect.width < 8) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    if (ratio <= 0.18) {
      if (page > 1) onEdgeClick("prev");
    } else if (ratio >= 0.82) {
      if (page < pageCount) onEdgeClick("next");
    }
  }

  function onPageBoxMouseMove(e: ReactMouseEvent<HTMLDivElement>) {
    if (noteMode || showNotesUi) {
      if (pageBoxRef.current) pageBoxRef.current.style.cursor = "default";
      if (hoverSide) setHoverSide(null);
      return;
    }
    const box = pageBoxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (rect.width < 8) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    if (ratio <= 0.18 && page > 1) {
      box.style.cursor = "pointer";
      if (hoverSide !== "prev") setHoverSide("prev");
    } else if (ratio >= 0.82 && page < pageCount) {
      box.style.cursor = "pointer";
      if (hoverSide !== "next") setHoverSide("next");
    } else {
      box.style.cursor = "default";
      if (hoverSide) setHoverSide(null);
    }
  }

  function clientToNorm(e: ReactMouseEvent, box: HTMLDivElement): { x: number; y: number } {
    const rect = box.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  }

  function onOverlayMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (!showNotesUi) return;
    if (e.button !== 0) return;
    const box = pageBoxRef.current;
    if (!box) return;
    const p = clientToNorm(e, box);
    dragOriginRef.current = p;
    setDrawing({ x: p.x, y: p.y, w: 0, h: 0 });
    setActiveAnnId(null);
  }

  function onOverlayMouseMove(e: ReactMouseEvent<HTMLDivElement>) {
    if (!showNotesUi) return;
    const origin = dragOriginRef.current;
    const box = pageBoxRef.current;
    if (!origin || !box) return;
    const p = clientToNorm(e, box);
    setDrawing({
      x: Math.min(origin.x, p.x),
      y: Math.min(origin.y, p.y),
      w: Math.abs(p.x - origin.x),
      h: Math.abs(p.y - origin.y),
    });
  }

  function finishDraw(e: ReactMouseEvent<HTMLDivElement>) {
    if (!showNotesUi) return;
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    if (!origin) return;
    const box = pageBoxRef.current;
    if (!box) {
      setDrawing(null);
      return;
    }
    const p = clientToNorm(e, box);
    const x = Math.min(origin.x, p.x);
    const y = Math.min(origin.y, p.y);
    const w = Math.abs(p.x - origin.x);
    const h = Math.abs(p.y - origin.y);
    setDrawing(null);
    if (w < 0.02 || h < 0.015) return;
    setDraftRect({ page, x, y, w, h });
    setDraftNote("");
    setDraftColor(DEFAULT_COLOR);
    setDraftOpen(true);
  }

  async function saveDraft() {
    if (!canAnnotate || entryId == null || !draftRect) return;
    setSaving(true);
    try {
      const created = await api.createAnnotation(entryId, {
        page: draftRect.page,
        rect_json: JSON.stringify({
          x: draftRect.x,
          y: draftRect.y,
          w: draftRect.w,
          h: draftRect.h,
        }),
        quote: `第${draftRect.page}页区域`,
        note: draftNote.trim(),
        color: draftColor,
        kind: "note",
      });
      setAnnotations((prev) => [...prev, created]);
      setActiveAnnId(created.id);
      setDraftOpen(false);
      setDraftRect(null);
      message.success("页内笔记已保存");
    } catch (err) {
      message.error(formatError(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  function openEdit(ann: EntryAnnotation) {
    setEditAnn(ann);
    setEditNote(ann.note || "");
    setEditColor(normalizeColor(ann.color));
    setEditOpen(true);
    setActiveAnnId(ann.id);
    if (ann.page && ann.page !== page) goPage(ann.page, "top");
  }

  async function saveEdit() {
    if (!editAnn) return;
    setSaving(true);
    try {
      const updated = await api.updateAnnotation(editAnn.id, {
        note: editNote,
        color: editColor,
      });
      setAnnotations((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      setEditOpen(false);
      setEditAnn(null);
      message.success("已更新");
    } catch (err) {
      message.error(formatError(err, "更新失败"));
    } finally {
      setSaving(false);
    }
  }

  async function removeAnn(annId: number) {
    setSaving(true);
    try {
      await api.deleteAnnotation(annId);
      setAnnotations((prev) => prev.filter((a) => a.id !== annId));
      if (activeAnnId === annId) setActiveAnnId(null);
      setEditOpen(false);
      setEditAnn(null);
      message.success("已删除");
    } catch (err) {
      message.error(formatError(err, "删除失败"));
    } finally {
      setSaving(false);
    }
  }

  function toggleNoteMode(checked: boolean) {
    if (checked && !canAnnotate) {
      message.info("入库后才能在 PDF 上记笔记");
      return;
    }
    setNoteMode(checked);
    setHoverSide(null);
    if (!checked) {
      setDrawing(null);
      dragOriginRef.current = null;
      setActiveAnnId(null);
    }
  }

  return (
    <>
      <Modal
        open={open}
        title={title || "PDF 预览"}
        onCancel={onClose}
        width={showNotesUi ? "min(1180px, 96vw)" : "min(980px, 96vw)"}
        className={styles.modal}
        centered
        destroyOnHidden
        footer={
          <Space wrap>
            <Typography.Text type="secondary" className={styles.hint}>
              {showNotesUi
                ? "笔记模式：拖拽框选写笔记"
                : resumedHint
                  ? `已回到上次阅读位置 · 第 ${page} 页`
                  : "点页面左/右侧翻页 · 滚轮 · ← → · 空格 · 自动记住页码"}
            </Typography.Text>
            {onOpenTextPreview ? (
              <Button icon={<FileTextOutlined />} onClick={onOpenTextPreview}>
                查看抽取正文
              </Button>
            ) : null}
            <Button type="primary" onClick={onClose}>
              关闭
            </Button>
          </Space>
        }
      >
        <div className={styles.toolbar}>
          <div className={styles.pageNav}>
            <Button
              size="small"
              icon={<LeftOutlined />}
              disabled={page <= 1}
              onClick={() => goPage(page - 1, "bottom")}
            />
            <InputNumber
              size="small"
              className={styles.pageInput}
              min={1}
              max={Math.max(1, pageCount)}
              value={page}
              onChange={(v) => typeof v === "number" && goPage(v, "top")}
            />
            <span>/ {pageCount || "—"}</span>
            <Button
              size="small"
              icon={<RightOutlined />}
              disabled={pageCount < 1 || page >= pageCount}
              onClick={() => goPage(page + 1, "top")}
            />
          </div>

          <div className={styles.fitGroup}>
            <Button
              size="small"
              type={fitMode === "width" ? "primary" : "default"}
              icon={<ColumnWidthOutlined />}
              onClick={() => {
                setFitMode("width");
                setZoom(1);
              }}
              title="适宽：横向铺满，纵向滚动"
            >
              适宽
            </Button>
            <Button
              size="small"
              type={fitMode === "page" ? "primary" : "default"}
              icon={<CompressOutlined />}
              onClick={() => {
                setFitMode("page");
                setZoom(1);
              }}
              title="整页：一屏看完整页"
            >
              整页
            </Button>
          </div>

          <div className={styles.zoomControls}>
            <Button
              size="small"
              icon={<ZoomOutOutlined />}
              disabled={zoom <= MIN_ZOOM}
              onClick={() => bumpZoom(-0.15)}
            />
            <span title={`适应 ${Math.round(fitScale * 100)}% × ${Math.round(zoom * 100)}%`}>
              {Math.round(zoom * 100)}%
            </span>
            <Button
              size="small"
              icon={<ZoomInOutlined />}
              disabled={zoom >= MAX_ZOOM}
              onClick={() => bumpZoom(0.15)}
            />
          </div>

          <label className={styles.noteToggle} title={canAnnotate ? "开启后可框选记笔记" : "入库后可用"}>
            <Switch
              size="small"
              checked={noteMode}
              disabled={!canAnnotate}
              onChange={toggleNoteMode}
              checkedChildren={<EditOutlined />}
              unCheckedChildren={<HighlightOutlined />}
            />
            <span>记笔记</span>
          </label>
        </div>

        <div className={`${styles.layout}${showNotesUi ? "" : ` ${styles.layoutSolo}`}`}>
          <div className={`${styles.stageShell}${noteMode ? ` ${styles.stageNote}` : ""}`}>
            {loading || rendering ? (
              <div className={styles.loading}>
                <Spin tip={loading ? "加载 PDF…" : "渲染中…"} />
              </div>
            ) : null}

            {/* 热区挂在滚动层外，始终可点，不被 PDF 盖住 */}
            {!noteMode && page > 1 ? (
              <button
                type="button"
                className={`${styles.edgeHit} ${styles.edgePrev}${
                  hoverSide === "prev" ? ` ${styles.edgeHitActive}` : ""
                }`}
                aria-label="上一页"
                onClick={() => onEdgeClick("prev")}
                onMouseEnter={() => setHoverSide("prev")}
                onMouseLeave={() => setHoverSide((s) => (s === "prev" ? null : s))}
                onWheel={(e) => {
                  const stage = stageRef.current;
                  if (stage) stage.scrollTop += e.deltaY;
                }}
              >
                <span className={styles.edgeBadge}>
                  <LeftOutlined />
                  <em>上一页</em>
                </span>
              </button>
            ) : null}
            {!noteMode && page < pageCount ? (
              <button
                type="button"
                className={`${styles.edgeHit} ${styles.edgeNext}${
                  hoverSide === "next" ? ` ${styles.edgeHitActive}` : ""
                }`}
                aria-label="下一页"
                onClick={() => onEdgeClick("next")}
                onMouseEnter={() => setHoverSide("next")}
                onMouseLeave={() => setHoverSide((s) => (s === "next" ? null : s))}
                onWheel={(e) => {
                  const stage = stageRef.current;
                  if (stage) stage.scrollTop += e.deltaY;
                }}
              >
                <span className={styles.edgeBadge}>
                  <RightOutlined />
                  <em>下一页</em>
                </span>
              </button>
            ) : null}

            <div ref={stageRef} className={styles.stage}>
            <div
              ref={pageBoxRef}
              className={`${styles.pageBox}${pageFading ? ` ${styles.pageFade}` : ""}${
                !noteMode ? ` ${styles.pageBoxRead}` : ""
              }`}
              style={
                pageSize.w
                  ? { width: pageSize.w, height: pageSize.h }
                  : { minWidth: 200, minHeight: 280 }
              }
              onClick={onPageBoxClick}
              onMouseMove={onPageBoxMouseMove}
              onMouseLeave={() => {
                if (pageBoxRef.current) pageBoxRef.current.style.cursor = "default";
                setHoverSide(null);
              }}
            >
              <canvas ref={canvasRef} className={styles.pageCanvas} />
              {!noteMode && hoverSide === "prev" && page > 1 ? (
                <div className={`${styles.pageSideGlow} ${styles.pageSidePrev}`} />
              ) : null}
              {!noteMode && hoverSide === "next" && page < pageCount ? (
                <div className={`${styles.pageSideGlow} ${styles.pageSideNext}`} />
              ) : null}
              {showNotesUi ? (
                <div
                  className={`${styles.overlay} ${styles.overlayDraw}`}
                  onMouseDown={onOverlayMouseDown}
                  onMouseMove={onOverlayMouseMove}
                  onMouseUp={finishDraw}
                  onMouseLeave={(e) => {
                    if (dragOriginRef.current) finishDraw(e);
                  }}
                >
                  {marksOnPage.map((ann) => {
                    const rect = parseRect(ann.rect_json);
                    if (!rect) return null;
                    const color = normalizeColor(ann.color);
                    return (
                      <button
                        key={ann.id}
                        type="button"
                        className={`${styles.rectMark}${
                          activeAnnId === ann.id ? ` ${styles.rectMarkActive}` : ""
                        }`}
                        style={{
                          left: `${rect.x * 100}%`,
                          top: `${rect.y * 100}%`,
                          width: `${rect.w * 100}%`,
                          height: `${rect.h * 100}%`,
                          borderColor: color,
                          background: `${color}33`,
                        }}
                        title={ann.note?.trim() || ann.quote}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit(ann);
                        }}
                      />
                    );
                  })}
                  {drawing && drawing.w > 0 && drawing.h > 0 ? (
                    <div
                      className={styles.draftRect}
                      style={{
                        left: `${drawing.x * 100}%`,
                        top: `${drawing.y * 100}%`,
                        width: `${drawing.w * 100}%`,
                        height: `${drawing.h * 100}%`,
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
            </div>
          </div>

          {showNotesUi ? (
            <aside className={styles.notePane}>
              <div className={styles.notePaneHead}>
                <span className={styles.notePaneTitle}>
                  <HighlightOutlined /> 页内笔记
                </span>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>{pageNotes.length}</span>
              </div>
              {pageNotes.length === 0 ? (
                <p className={styles.noteEmpty}>拖拽框选区域即可写笔记。关闭「记笔记」可回到纯阅读。</p>
              ) : (
                <ul className={styles.noteList}>
                  {pageNotes.map((ann) => (
                    <li key={ann.id}>
                      <button
                        type="button"
                        className={`${styles.noteItem}${
                          activeAnnId === ann.id ? ` ${styles.noteItemActive}` : ""
                        }`}
                        onClick={() => openEdit(ann)}
                      >
                        <span
                          className={styles.noteDot}
                          style={{ background: normalizeColor(ann.color) }}
                        />
                        <span className={styles.noteText}>
                          <strong>{ann.note?.trim() || "仅区域标记"}</strong>
                          <em>{ann.quote}</em>
                          <small>第 {ann.page} 页</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          ) : null}
        </div>
      </Modal>

      <Modal
        title="写页内笔记"
        open={draftOpen}
        onCancel={() => {
          setDraftOpen(false);
          setDraftRect(null);
        }}
        onOk={() => void saveDraft()}
        confirmLoading={saving}
        okText="保存"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" className={styles.quoteBox}>
          {draftRect ? `第 ${draftRect.page} 页 · 已框选区域` : ""}
        </Typography.Paragraph>
        <ColorPicker value={draftColor} onChange={setDraftColor} />
        <Input.TextArea
          rows={4}
          value={draftNote}
          onChange={(e) => setDraftNote(e.target.value)}
          placeholder="写下你对这个区域的理解（可空，仅标记）"
          maxLength={2000}
        />
      </Modal>

      <Modal
        title="编辑页内笔记"
        open={editOpen}
        onCancel={() => {
          setEditOpen(false);
          setEditAnn(null);
        }}
        onOk={() => void saveEdit()}
        confirmLoading={saving}
        okText="保存"
        destroyOnHidden
        footer={(_, { OkBtn, CancelBtn }) => (
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <Popconfirm
              title="删除这条页内笔记？"
              onConfirm={() => editAnn && void removeAnn(editAnn.id)}
            >
              <Button danger icon={<DeleteOutlined />} loading={saving}>
                删除
              </Button>
            </Popconfirm>
            <Space>
              <CancelBtn />
              <OkBtn />
            </Space>
          </Space>
        )}
      >
        <Typography.Paragraph type="secondary" className={styles.quoteBox}>
          {editAnn?.quote || (editAnn?.page ? `第 ${editAnn.page} 页` : "")}
        </Typography.Paragraph>
        <ColorPicker value={editColor} onChange={setEditColor} />
        <Input.TextArea
          rows={4}
          value={editNote}
          onChange={(e) => setEditNote(e.target.value)}
          placeholder="笔记内容"
          maxLength={2000}
        />
      </Modal>
    </>
  );
}
