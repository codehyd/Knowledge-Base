import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageInstance } from "antd/es/message/interface";
import type { SetURLSearchParams } from "react-router-dom";
import { api } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { tabFromNote, type NoteTab } from "../types";

export type UnsavedConfirm =
  | { type: "switch"; next: boolean }
  | { type: "closeTab"; sourceId: number }
  | null;

export type EditorDraft = {
  content: string;
  lake: string | null;
};

export type UseNoteTabsOptions = {
  message: MessageInstance;
  setParams: SetURLSearchParams;
  refreshTree: () => Promise<void>;
  selectedFolder: string;
  params: URLSearchParams;
  readEditorDraft: () => EditorDraft;
  lakeModeRef: React.RefObject<boolean>;
};

export function useNoteTabs({
  message,
  setParams,
  refreshTree,
  selectedFolder,
  params,
  readEditorDraft,
  lakeModeRef,
}: UseNoteTabsOptions) {
  const [tabs, setTabs] = useState<NoteTab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [contentKey, setContentKey] = useState(0);
  const [loadingNote, setLoadingNote] = useState(false);
  const [unsavedConfirm, setUnsavedConfirm] = useState<UnsavedConfirm>(null);
  const [draggingTabId, setDraggingTabId] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<{ id: number; side: "before" | "after" } | null>(null);

  const tabDragMovedRef = useRef(false);
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  tabsRef.current = tabs;
  activeIdRef.current = activeId;

  const activeTab = activeId != null ? tabs.find((t) => t.sourceId === activeId) ?? null : null;

  const flushActiveDraft = useCallback(() => {
    const id = activeIdRef.current;
    if (id == null) return;
    const { content, lake } = readEditorDraft();
    setTabs((prev) =>
      prev.map((t) =>
        t.sourceId === id
          ? {
              ...t,
              draftContent: content,
              draftLake: lakeModeRef.current ? lake : t.draftLake,
            }
          : t,
      ),
    );
  }, [readEditorDraft, lakeModeRef]);

  const activateTab = useCallback(
    (sourceId: number) => {
      if (sourceId === activeIdRef.current) return;
      flushActiveDraft();
      setActiveId(sourceId);
      setParams({ id: String(sourceId) }, { replace: true });
      setContentKey((k) => k + 1);
    },
    [flushActiveDraft, setParams],
  );

  const removeTab = useCallback(
    (sourceId: number) => {
      const prev = tabsRef.current;
      const idx = prev.findIndex((t) => t.sourceId === sourceId);
      if (idx < 0) return;
      const next = prev.filter((t) => t.sourceId !== sourceId);
      setTabs(next);
      if (activeIdRef.current !== sourceId) return;
      const neighbor = next[idx] ?? next[idx - 1] ?? null;
      if (neighbor) {
        setActiveId(neighbor.sourceId);
        setParams({ id: String(neighbor.sourceId) }, { replace: true });
        setContentKey((k) => k + 1);
      } else {
        setActiveId(null);
        setParams({}, { replace: true });
      }
    },
    [setParams],
  );

  const closeTab = useCallback(
    (sourceId: number, force = false) => {
      const tab = tabsRef.current.find((t) => t.sourceId === sourceId);
      if (!tab) return;
      if (tab.dirty && !force) {
        setUnsavedConfirm({ type: "closeTab", sourceId });
        return;
      }
      if (sourceId === activeIdRef.current) {
        // 丢弃当前编辑器未 flush 的脏内容
      } else {
        flushActiveDraft();
      }
      removeTab(sourceId);
    },
    [flushActiveDraft, removeTab],
  );

  const reorderTabs = useCallback((fromId: number, toId: number, side: "before" | "after") => {
    if (fromId === toId) return;
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.sourceId === fromId);
      if (fromIdx < 0) return prev;
      const next = [...prev];
      const [item] = next.splice(fromIdx, 1);
      let toIdx = next.findIndex((t) => t.sourceId === toId);
      if (toIdx < 0) return prev;
      if (side === "after") toIdx += 1;
      next.splice(toIdx, 0, item);
      return next;
    });
  }, []);

  const clearTabDrag = useCallback(() => {
    setDraggingTabId(null);
    setDragOver(null);
  }, []);

  const openNote = useCallback(
    async (sourceId: number) => {
      if (tabsRef.current.some((t) => t.sourceId === sourceId)) {
        activateTab(sourceId);
        return;
      }
      setLoadingNote(true);
      try {
        const res = await api.getVaultNote(sourceId);
        flushActiveDraft();
        setTabs((prev) => {
          if (prev.some((t) => t.sourceId === res.source_id)) return prev;
          return [...prev, tabFromNote(res)];
        });
        setActiveId(res.source_id);
        setParams({ id: String(res.source_id) }, { replace: true });
        setContentKey((k) => k + 1);
      } catch (err) {
        message.error(formatError(err));
      } finally {
        setLoadingNote(false);
      }
    },
    [activateTab, flushActiveDraft, message, setParams],
  );

  const markActiveDirty = useCallback((nextDirty: boolean) => {
    const id = activeIdRef.current;
    if (id == null) return;
    setTabs((prev) =>
      prev.map((t) => (t.sourceId === id ? { ...t, dirty: nextDirty } : t)),
    );
  }, []);

  const setActiveTitle = useCallback((nextTitle: string) => {
    const id = activeIdRef.current;
    if (id == null) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.sourceId === id
          ? { ...t, draftTitle: nextTitle, title: nextTitle, dirty: true }
          : t,
      ),
    );
  }, []);

  const resetActiveTabFromServer = useCallback(() => {
    const id = activeIdRef.current;
    if (id == null) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.sourceId === id
          ? {
              ...t,
              draftTitle: t.note.title || "",
              draftContent: t.note.content,
              draftLake: t.note.source_lake ?? null,
              dirty: false,
            }
          : t,
      ),
    );
  }, []);

  const confirmUnsavedCloseTab = useCallback(() => {
    if (unsavedConfirm?.type !== "closeTab") return;
    const { sourceId } = unsavedConfirm;
    setUnsavedConfirm(null);
    removeTab(sourceId);
  }, [unsavedConfirm, removeTab]);

  const importHandledRef = useRef<string | null>(null);
  const newHandledRef = useRef(false);

  useEffect(() => {
    const importId = params.get("import");
    const id = params.get("id");
    const isNew = params.get("new") === "1";

    void (async () => {
      if (isNew) {
        if (newHandledRef.current) return;
        newHandledRef.current = true;
        try {
          const res = await api.createVaultNote({
            parent: selectedFolder,
            title: "未命名笔记",
          });
          await refreshTree();
          setParams({ id: String(res.source_id) }, { replace: true });
          flushActiveDraft();
          setTabs((prev) => {
            if (prev.some((t) => t.sourceId === res.source_id)) return prev;
            return [...prev, tabFromNote(res)];
          });
          setActiveId(res.source_id);
          setContentKey((k) => k + 1);
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
          if (tabsRef.current.some((t) => t.sourceId === num)) {
            if (num !== activeIdRef.current) {
              flushActiveDraft();
              setActiveId(num);
              setContentKey((k) => k + 1);
            }
          } else if (num !== activeIdRef.current) {
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
          flushActiveDraft();
          setTabs((prev) => {
            if (prev.some((t) => t.sourceId === res.source_id)) return prev;
            return [...prev, tabFromNote(res)];
          });
          setActiveId(res.source_id);
          setContentKey((k) => k + 1);
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
    tabsRef,
    activeIdRef,
    activateTab,
    removeTab,
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
