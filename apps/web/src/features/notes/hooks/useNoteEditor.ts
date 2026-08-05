import { useCallback, useEffect, useRef } from "react";
import type { MessageInstance } from "antd/es/message/interface";
import type { MarkdownEditorHandle } from "@/shared/ui/markdown-editor";
import type { LakeEditorHandle } from "@/shared/ui/lake-editor";
import {
  registerReadEditorDraft,
  selectActiveTab,
  useNotesStore,
} from "../store/notesStore";

export type UseNoteEditorOptions = {
  message: MessageInstance;
};

export function useNoteEditor({ message }: UseNoteEditorOptions) {
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const lakeRef = useRef<LakeEditorHandle>(null);

  const activeId = useNotesStore((s) => s.activeId);
  const activeTab = useNotesStore(selectActiveTab);
  const saving = useNotesStore((s) => s.saving);
  const lakeMode = useNotesStore((s) => s.lakeMode);
  const lakeFocus = useNotesStore((s) => s.lakeFocus);
  const mdBooting = useNotesStore((s) => s.mdBooting);

  const markActiveDirty = useNotesStore((s) => s.markActiveDirty);
  const setLakeFocusRemembered = useNotesStore((s) => s.setLakeFocusRemembered);
  const applyLakeMode = useNotesStore((s) => s.applyLakeMode);
  const onToggleLakeMode = useNotesStore((s) => s.onToggleLakeMode);
  const saveActiveNote = useNotesStore((s) => s.saveActiveNote);
  const flushActiveDraft = useNotesStore((s) => s.flushActiveDraft);

  const lakeModeRef = useRef(lakeMode);
  lakeModeRef.current = lakeMode;

  const readEditorDraft = useCallback(() => {
    const content = lakeModeRef.current
      ? (lakeRef.current?.getMarkdown() ?? "")
      : (editorRef.current?.getMarkdown() ?? "");
    const lake = lakeModeRef.current ? (lakeRef.current?.getLakeSource() ?? null) : null;
    return { content, lake };
  }, []);

  useEffect(() => {
    registerReadEditorDraft(readEditorDraft);
    return () => {
      registerReadEditorDraft(() => ({ content: "", lake: null }));
    };
  }, [readEditorDraft]);

  const dirty = activeTab?.dirty ?? false;
  const title = activeTab?.draftTitle ?? "";
  const note = activeTab?.note ?? null;

  const save = useCallback(async () => {
    if (activeId == null) return;
    await saveActiveNote({ message, activeId });
  }, [activeId, message, saveActiveNote]);

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
    flushActiveDraft,
  };
}
