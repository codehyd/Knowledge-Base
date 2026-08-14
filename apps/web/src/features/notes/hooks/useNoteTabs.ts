import { useCallback, useEffect, useRef } from "react";
import type { MessageInstance } from "antd/es/message/interface";
import type { SetURLSearchParams } from "react-router-dom";
import { api } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { tabFromNote } from "../types";
import {
  selectActiveTab,
  useNotesStore,
  type UnsavedConfirm,
} from "../store/notesStore";

export type { UnsavedConfirm };
export type { EditorDraft } from "../store/notesStore";

export type UseNoteTabsOptions = {
  message: MessageInstance;
  setParams: SetURLSearchParams;
  refreshTree: () => Promise<void>;
  selectedFolder: string;
  params: URLSearchParams;
};

export function useNoteTabs({
  message,
  setParams,
  refreshTree,
  selectedFolder,
  params,
}: UseNoteTabsOptions) {
  const tabs = useNotesStore((s) => s.tabs);
  const activeId = useNotesStore((s) => s.activeId);
  const contentKey = useNotesStore((s) => s.contentKey);
  const loadingNote = useNotesStore((s) => s.loadingNote);
  const unsavedConfirm = useNotesStore((s) => s.unsavedConfirm);
  const draggingTabId = useNotesStore((s) => s.draggingTabId);
  const dragOver = useNotesStore((s) => s.dragOver);

  const setTabs = useNotesStore((s) => s.setTabs);
  const setActiveId = useNotesStore((s) => s.setActiveId);
  const setContentKey = useNotesStore((s) => s.setContentKey);
  const setUnsavedConfirm = useNotesStore((s) => s.setUnsavedConfirm);
  const setDraggingTabId = useNotesStore((s) => s.setDraggingTabId);
  const setDragOver = useNotesStore((s) => s.setDragOver);
  const clearTabDrag = useNotesStore((s) => s.clearTabDrag);
  const flushActiveDraft = useNotesStore((s) => s.flushActiveDraft);
  const activateTab = useNotesStore((s) => s.activateTab);
  const removeTab = useNotesStore((s) => s.removeTab);
  const closeTabAction = useNotesStore((s) => s.closeTab);
  const reorderTabs = useNotesStore((s) => s.reorderTabs);
  const openNoteAction = useNotesStore((s) => s.openNote);
  const markActiveDirty = useNotesStore((s) => s.markActiveDirty);
  const setActiveTitle = useNotesStore((s) => s.setActiveTitle);
  const resetActiveTabFromServer = useNotesStore((s) => s.resetActiveTabFromServer);

  const activeTab = useNotesStore(selectActiveTab);
  const tabDragMovedRef = useRef(false);

  const activateTabBound = useCallback(
    (sourceId: number) => activateTab(sourceId, setParams),
    [activateTab, setParams],
  );

  const removeTabBound = useCallback(
    (sourceId: number) => removeTab(sourceId, setParams),
    [removeTab, setParams],
  );

  const closeTab = useCallback(
    (sourceId: number, force = false) => closeTabAction(sourceId, setParams, force),
    [closeTabAction, setParams],
  );

  const openNote = useCallback(
    (sourceId: number) => openNoteAction(sourceId, { message, setParams }),
    [message, openNoteAction, setParams],
  );

  const confirmUnsavedCloseTab = useCallback(() => {
    if (unsavedConfirm?.type !== "closeTab") return;
    const { sourceId } = unsavedConfirm;
    setUnsavedConfirm(null);
    removeTabBound(sourceId);
  }, [unsavedConfirm, removeTabBound, setUnsavedConfirm]);

  const importHandledRef = useRef<string | null>(null);
  const newHandledRef = useRef(false);

  useEffect(() => {
    const importId = params.get("import");
    const id = params.get("id");
    const isNew = params.get("new") === "1";

    void (async () => {
      const store = useNotesStore.getState();

      if (isNew) {
        if (newHandledRef.current) return;
        newHandledRef.current = true;
        try {
          const res = await api.createVaultNote({
            parent: selectedFolder,
            title: "未命名笔记",
          });
          setParams({ id: String(res.source_id) }, { replace: true });
          store.flushActiveDraft();
          store.setTabs((prev) => {
            if (prev.some((t) => t.sourceId === res.source_id)) return prev;
            return [...prev, tabFromNote(res)];
          });
          store.setActiveId(res.source_id);
          void refreshTree();
        } catch (err) {
          newHandledRef.current = false;
          message.error(formatError(err));
        }
        return;
      }
      newHandledRef.current = false;

      if (id) {
        const num = Number(id);
        if (!Number.isNaN(num)) {
          const current = useNotesStore.getState();
          if (current.tabs.some((t) => t.sourceId === num)) {
            if (num !== current.activeId) {
              current.flushActiveDraft();
              current.setActiveId(num);
            }
          } else if (num !== current.activeId) {
            await openNote(num);
          }
        }
        if (importId) {
          setParams({ id }, { replace: true });
        }
        return;
      }

      if (importId) {
        if (importHandledRef.current === importId) return;
        importHandledRef.current = importId;
        try {
          const res = await api.importVaultNote({ source_id: Number(importId) });
          if (params.get("import") !== importId || params.get("id")) return;
          await refreshTree();
          setParams({ id: String(res.source_id) }, { replace: true });
          const latest = useNotesStore.getState();
          latest.flushActiveDraft();
          latest.setTabs((prev) => {
            if (prev.some((t) => t.sourceId === res.source_id)) return prev;
            return [...prev, tabFromNote(res)];
          });
          latest.setActiveId(res.source_id);
          latest.setContentKey((k) => k + 1);
          message.success("已导入笔记库");
        } catch (err) {
          importHandledRef.current = null;
          setParams({}, { replace: true });
          message.error(formatError(err));
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get("id"), params.get("new"), params.get("import")]);

  return {
    tabs,
    setTabs,
    activeId,
    activeTab,
    contentKey,
    setContentKey,
    loadingNote,
    unsavedConfirm,
    setUnsavedConfirm,
    draggingTabId,
    setDraggingTabId,
    dragOver,
    setDragOver,
    tabDragMovedRef,
    activateTab: activateTabBound,
    removeTab: removeTabBound,
    closeTab,
    reorderTabs,
    clearTabDrag,
    openNote,
    flushActiveDraft,
    markActiveDirty,
    setActiveTitle,
    resetActiveTabFromServer,
    confirmUnsavedCloseTab,
  };
}
