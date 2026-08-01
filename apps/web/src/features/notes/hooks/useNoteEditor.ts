import { useCallback, useRef, useState } from "react";
import type { MessageInstance } from "antd/es/message/interface";
import { api } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import type { MarkdownEditorHandle } from "@/shared/ui/markdown-editor";
import type { LakeEditorHandle } from "@/shared/ui/lake-editor";
import type { NoteTab } from "../types";
import type { UnsavedConfirm } from "./useNoteTabs";

const LAKE_MODE_KEY = "kongku-notes-lake-mode";
const LAKE_FOCUS_KEY = "kongku-notes-lake-focus";

export type UseNoteEditorOptions = {
  message: MessageInstance;
  activeId: number | null;
  activeTab: NoteTab | null;
  tabsRef: React.RefObject<NoteTab[]>;
  setTabs: React.Dispatch<React.SetStateAction<NoteTab[]>>;
  refreshTree: () => Promise<void>;
  flushActiveDraft: () => void;
  markActiveDirty: (dirty: boolean) => void;
  resetActiveTabFromServer: () => void;
  setContentKey: React.Dispatch<React.SetStateAction<number>>;
  setUnsavedConfirm: React.Dispatch<React.SetStateAction<UnsavedConfirm>>;
};

export function useNoteEditor({
  message,
  activeId,
  activeTab,
  tabsRef,
  setTabs,
  refreshTree,
  flushActiveDraft,
  markActiveDirty,
  resetActiveTabFromServer,
  setContentKey,
  setUnsavedConfirm,
}: UseNoteEditorOptions) {
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const lakeRef = useRef<LakeEditorHandle>(null);

  const [saving, setSaving] = useState(false);
  const [lakeMode, setLakeMode] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(LAKE_MODE_KEY) === "1",
  );
  const [lakeFocus, setLakeFocus] = useState(() => {
    if (typeof localStorage === "undefined") return true;
    const saved = localStorage.getItem(LAKE_FOCUS_KEY);
    return saved == null ? true : saved === "1";
  });
  const [mdBooting, setMdBooting] = useState(false);

  const lakeModeRef = useRef(lakeMode);
  lakeModeRef.current = lakeMode;

  const setLakeFocusRemembered = useCallback((next: boolean) => {
    setLakeFocus(next);
    localStorage.setItem(LAKE_FOCUS_KEY, next ? "1" : "0");
  }, []);

  const readEditorDraft = useCallback(() => {
    const content = lakeModeRef.current
      ? (lakeRef.current?.getMarkdown() ?? "")
      : (editorRef.current?.getMarkdown() ?? "");
    const lake = lakeModeRef.current ? (lakeRef.current?.getLakeSource() ?? null) : null;
    return { content, lake };
  }, []);

  const dirty = activeTab?.dirty ?? false;
  const title = activeTab?.draftTitle ?? "";
  const note = activeTab?.note ?? null;

  const save = useCallback(async () => {
    if (activeId == null) return;
    const { content, lake } = readEditorDraft();
    const draftTitle =
      tabsRef.current?.find((t) => t.sourceId === activeId)?.draftTitle.trim() ?? "";
    setSaving(true);
    try {
      const res = await api.saveVaultNote(activeId, {
        title: draftTitle,
        content,
        ...(lakeMode ? { source_lake: lake } : {}),
      });
      setTabs((prev) =>
        prev.map((t) =>
          t.sourceId === activeId
            ? {
                ...t,
                note: res,
                title: res.title,
                path: res.path,
                draftTitle: res.title,
                draftContent: res.content,
                draftLake: res.source_lake ?? t.draftLake,
                dirty: false,
              }
            : t,
        ),
      );
      message.success(res.committed ? "已保存并入库" : "已保存");
      void refreshTree();
    } catch (err) {
      message.error(formatError(err));
    } finally {
      setSaving(false);
    }
  }, [activeId, lakeMode, message, readEditorDraft, refreshTree, setTabs, tabsRef]);

  const applyLakeMode = useCallback(
    (next: boolean) => {
      resetActiveTabFromServer();
      setLakeMode(next);
      localStorage.setItem(LAKE_MODE_KEY, next ? "1" : "0");
      if (next) {
        const saved = localStorage.getItem(LAKE_FOCUS_KEY);
        setLakeFocus(saved == null ? true : saved === "1");
      } else {
        setMdBooting(true);
        window.setTimeout(() => setMdBooting(false), 550);
      }
      setContentKey((k) => k + 1);
      setUnsavedConfirm(null);
    },
    [resetActiveTabFromServer, setContentKey, setUnsavedConfirm],
  );

  const onToggleLakeMode = useCallback(
    (next: boolean) => {
      if (dirty) {
        setUnsavedConfirm({ type: "switch", next });
        return;
      }
      flushActiveDraft();
      setLakeMode(next);
      localStorage.setItem(LAKE_MODE_KEY, next ? "1" : "0");
      if (next) {
        const saved = localStorage.getItem(LAKE_FOCUS_KEY);
        setLakeFocus(saved == null ? true : saved === "1");
      } else {
        setMdBooting(true);
        window.setTimeout(() => setMdBooting(false), 550);
      }
      setContentKey((k) => k + 1);
    },
    [dirty, flushActiveDraft, setContentKey, setUnsavedConfirm],
  );

  return {
    editorRef,
    lakeRef,
    saving,
    lakeMode,
    lakeFocus,
    lakeModeRef,
    mdBooting,
    dirty,
    title,
    note,
    readEditorDraft,
    save,
    onToggleLakeMode,
    applyLakeMode,
    setLakeFocusRemembered,
    markActiveDirty,
  };
}
