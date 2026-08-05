import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject, RefObject } from "react";
import type { MessageInstance } from "antd/es/message/interface";
import { api, type EntryAnnotation } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { getSelectionOffsets } from "./previewOffsets";
import {
  anchorLabel,
  DEFAULT_COLOR,
  isChatAnchor,
  normalizeColor,
  type PendingSel,
} from "./previewHighlight";
import { PAD, type LoadAtOptions } from "./usePreviewLoader";

type LoaderRefs = {
  bodyRef: RefObject<HTMLDivElement | null>;
  baseOffsetRef: MutableRefObject<number>;
  segmentRef: MutableRefObject<string>;
  loadAt: (offset: number, options?: LoadAtOptions) => Promise<LoadAtOptions | undefined>;
};

export function usePreviewAnnotations(
  entryId: number | null | undefined,
  message: MessageInstance,
  loader: LoaderRefs,
) {
  const notesEnabled = entryId != null && entryId > 0;

  const [annotations, setAnnotations] = useState<EntryAnnotation[]>([]);
  const [noteTab, setNoteTab] = useState<"note" | "anchor">("note");
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
  const [editRange, setEditRange] = useState<{
    start: number;
    end: number;
    quote: string;
  } | null>(null);
  const [reselectMode, setReselectMode] = useState(false);
  const [showHighlights, setShowHighlights] = useState(true);
  const [stackPopup, setStackPopup] = useState<{
    x: number;
    y: number;
    ids: number[];
  } | null>(null);

  const editOpenRef = useRef(false);
  editOpenRef.current = editOpen;
  const reselectModeRef = useRef(false);
  reselectModeRef.current = reselectMode;
  const pendingSelRef = useRef<PendingSel | null>(null);
  pendingSelRef.current = pendingSel;
  const draftOpenRef = useRef(false);
  draftOpenRef.current = draftOpen;
  const ignoreDismissUntilRef = useRef(0);
  const skipAnnClickRef = useRef(false);

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

  function resetAnnotations() {
    setPendingSel(null);
    setDraftOpen(false);
    setDraftSel(null);
    setActiveAnnId(null);
    setEditOpen(false);
    setEditAnn(null);
    setEditRange(null);
    setReselectMode(false);
    setStackPopup(null);
    setNoteTab("note");
  }

  async function refreshAnnotations() {
    if (!notesEnabled || entryId == null) {
      setAnnotations([]);
      return;
    }
    const res = await api.listAnnotations(entryId);
    setAnnotations(res.items);
  }

  function openAnnotationDetail(ann: EntryAnnotation) {
    clearPendingSel();
    setStackPopup(null);
    setReselectMode(false);
    setActiveAnnId(ann.id);
    setNoteTab(isChatAnchor(ann) ? "anchor" : "note");
    setEditAnn(ann);
    setEditNote(isChatAnchor(ann) ? anchorLabel(ann) : ann.note || "");
    setEditColor(normalizeColor(ann.color));
    setEditRange(null);
    setEditOpen(true);
  }

  function beginReselectRange() {
    if (!editAnn) return;
    clearPendingSel();
    setEditOpen(false);
    setReselectMode(true);
    message.info("请在正文中拖选新的高亮范围");
  }

  function cancelReselectMode() {
    setReselectMode(false);
    if (editAnn) setEditOpen(true);
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
        kind: "note",
      });
      await refreshAnnotations();
      setNoteTab("note");
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

  async function promoteAnn() {
    if (!editAnn || !isChatAnchor(editAnn)) return;
    setSaving(true);
    try {
      await api.promoteAnnotation(editAnn.id, {
        note: editNote.trim(),
        color: normalizeColor(editColor),
      });
      await refreshAnnotations();
      setNoteTab("note");
      setEditOpen(false);
      setEditAnn(null);
      setEditRange(null);
      setReselectMode(false);
      setActiveAnnId(null);
      message.success("已加入正式笔记");
    } catch (err) {
      message.error(formatError(err, "加入笔记失败"));
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit() {
    if (!editAnn) return;
    setSaving(true);
    try {
      const body: {
        note?: string;
        color?: string;
        start_offset?: number;
        end_offset?: number;
        quote?: string;
      } = {
        color: normalizeColor(editColor),
      };
      if (isChatAnchor(editAnn)) {
        const label = editNote.trim() || anchorLabel(editAnn);
        body.note = label ? `对话引用｜${label}` : "对话引用";
      } else {
        body.note = editNote;
      }
      if (editRange) {
        body.start_offset = editRange.start;
        body.end_offset = editRange.end;
        body.quote = editRange.quote;
      }
      const updated = await api.updateAnnotation(editAnn.id, body);
      await refreshAnnotations();
      setEditAnn(updated);
      setEditRange(null);
      message.success("已保存");
      if (!isChatAnchor(updated)) {
        setEditOpen(false);
        setEditAnn(null);
        setActiveAnnId(null);
      }
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
      setEditRange(null);
      setReselectMode(false);
      message.success("已删除");
    } catch (err) {
      message.error(formatError(err, "删除失败"));
    }
  }

  async function jumpToAnnotation(ann: EntryAnnotation) {
    setActiveAnnId(ann.id);
    setNoteTab(isChatAnchor(ann) ? "anchor" : "note");
    const windowStart = Math.max(0, ann.start_offset - PAD);
    if (
      ann.start_offset >= loader.baseOffsetRef.current &&
      ann.end_offset <= loader.baseOffsetRef.current + loader.segmentRef.current.length
    ) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          const mark = loader.bodyRef.current?.querySelector(
            `mark[data-ann-id="${ann.id}"]`,
          ) as HTMLElement | null;
          mark?.scrollIntoView({ block: "center", behavior: "smooth" });
          resolve();
        });
      });
      return;
    }
    await loader.loadAt(windowStart, { annId: ann.id, preserve: "none" });
  }

  async function focusAnnotation(ann: EntryAnnotation) {
    await jumpToAnnotation(ann);
    openAnnotationDetail(ann);
  }

  function onBodyMouseUp(e: ReactMouseEvent) {
    if (!notesEnabled || !loader.bodyRef.current) return;
    const target = e.target as HTMLElement;
    if (target.closest?.("[data-sel-popup]")) return;
    if (e.detail >= 2) return;

    const pointer = { x: e.clientX, y: e.clientY };

    if (reselectModeRef.current) {
      const sel = getSelectionOffsets(loader.bodyRef.current, loader.baseOffsetRef.current, pointer);
      if (!sel) {
        message.info("请按住鼠标拖选一段文字（不超过 2000 字）");
        return;
      }
      ignoreDismissUntilRef.current = Date.now() + 350;
      skipAnnClickRef.current = true;
      setEditRange({ start: sel.start, end: sel.end, quote: sel.quote });
      setReselectMode(false);
      setEditOpen(true);
      window.getSelection()?.removeAllRanges();
      message.success("范围已更新，确认后点保存");
      return;
    }

    if (editOpenRef.current) return;

    const sel = getSelectionOffsets(loader.bodyRef.current, loader.baseOffsetRef.current, pointer);
    if (!sel) return;

    ignoreDismissUntilRef.current = Date.now() + 350;
    skipAnnClickRef.current = true;
    setStackPopup(null);
    setPendingSel({
      x: sel.x,
      y: sel.y,
      start: sel.start,
      end: sel.end,
      quote: sel.quote,
      color: normalizeColor(pendingSelRef.current?.color),
      placeBelow: sel.placeBelow,
    });
    window.getSelection()?.removeAllRanges();
  }

  function onBodyClick(e: ReactMouseEvent) {
    if (editOpenRef.current || reselectModeRef.current) return;
    if (skipAnnClickRef.current) {
      skipAnnClickRef.current = false;
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest?.("[data-sel-popup]")) return;
    if (target.closest?.("[data-stack-popup]")) return;
    const mark = target.closest?.("mark[data-ann-id]") as HTMLElement | null;
    if (!mark) {
      setStackPopup(null);
      setActiveAnnId(null);
      dismissPendingIfIdle();
      return;
    }
    const stackRaw = mark.getAttribute("data-stack-ids") || "";
    const stackIds = stackRaw
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (stackIds.length > 1) {
      setStackPopup({
        x: e.clientX,
        y: e.clientY,
        ids: stackIds,
      });
      clearPendingSel();
      return;
    }
    setStackPopup(null);
  }

  function onBodyDoubleClick(e: ReactMouseEvent) {
    if (editOpenRef.current || reselectModeRef.current) return;
    if (!notesEnabled) return;
    const target = e.target as HTMLElement;
    if (target.closest?.("[data-sel-popup]")) return;
    if (target.closest?.("[data-stack-popup]")) return;
    const mark = target.closest?.("mark[data-ann-id]") as HTMLElement | null;
    if (!mark) return;

    const stackRaw = mark.getAttribute("data-stack-ids") || "";
    const stackIds = stackRaw
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (stackIds.length > 1) return;

    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    clearPendingSel();
    setStackPopup(null);
    const id = Number(mark.getAttribute("data-ann-id"));
    if (!id) return;
    const ann = annotations.find((a) => a.id === id);
    if (!ann) return;
    openAnnotationDetail(ann);
  }

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

  useEffect(() => {
    if (!stackPopup) return;
    function onDocPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-stack-popup]")) return;
      if (target?.closest?.("mark[data-stack-ids]")) return;
      setStackPopup(null);
    }
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [stackPopup]);

  useEffect(() => {
    if (!showHighlights) setStackPopup(null);
  }, [showHighlights]);

  // 正文预览只展示偏移批注；PDF 页注在 PdfPreviewModal 中管理
  const textAnnotations = annotations.filter((a) => a.page == null || a.page <= 0);
  const userNotes = textAnnotations.filter((a) => !isChatAnchor(a));
  const chatAnchors = textAnnotations.filter((a) => isChatAnchor(a));
  const paneNotes = noteTab === "anchor" ? chatAnchors : userNotes;

  const stackPopupItems = stackPopup
    ? stackPopup.ids
        .map((id) => annotations.find((a) => a.id === id))
        .filter((a): a is EntryAnnotation => a != null)
        .sort((a, b) => {
          const ak = isChatAnchor(a) ? 1 : 0;
          const bk = isChatAnchor(b) ? 1 : 0;
          if (ak !== bk) return ak - bk;
          return String(b.created_at || "").localeCompare(String(a.created_at || ""));
        })
    : [];

  return {
    notesEnabled,
    annotations,
    setAnnotations,
    noteTab,
    setNoteTab,
    activeAnnId,
    setActiveAnnId,
    pendingSel,
    draftOpen,
    setDraftOpen,
    draftNote,
    setDraftNote,
    draftColor,
    setDraftColor,
    draftSel,
    setDraftSel,
    saving,
    editOpen,
    setEditOpen,
    editAnn,
    setEditAnn,
    editNote,
    setEditNote,
    editColor,
    setEditColor,
    editRange,
    setEditRange,
    reselectMode,
    setReselectMode,
    showHighlights,
    setShowHighlights,
    stackPopup,
    setStackPopup,
    userNotes,
    chatAnchors,
    paneNotes,
    stackPopupItems,
    clearPendingSel,
    dismissPendingIfIdle,
    resetAnnotations,
    refreshAnnotations,
    openAnnotationDetail,
    beginReselectRange,
    cancelReselectMode,
    setPendingColor,
    openNoteDraft,
    saveAnnotation,
    confirmHighlight,
    promoteAnn,
    saveEdit,
    removeAnn,
    jumpToAnnotation,
    focusAnnotation,
    onBodyMouseUp,
    onBodyClick,
    onBodyDoubleClick,
  };
}
