import { useCallback, useEffect, useRef } from "react";
import type { MessageInstance } from "antd/es/message/interface";
import type { MarkdownEditorHandle } from "@/shared/ui/markdown-editor";
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

  const activeId = useNotesStore((s) => s.activeId);
  const activeTab = useNotesStore(selectActiveTab);
  const saving = useNotesStore((s) => s.saving);

  const markActiveDirty = useNotesStore((s) => s.markActiveDirty);
  const saveActiveNote = useNotesStore((s) => s.saveActiveNote);
  const flushActiveDraft = useNotesStore((s) => s.flushActiveDraft);

  const readEditorDraft = useCallback(() => {
    return { content: editorRef.current?.getMarkdown() ?? "" };
  }, []);

  useEffect(() => {
    registerReadEditorDraft(readEditorDraft);
    return () => {
      registerReadEditorDraft(() => ({ content: "" }));
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
    saving,
    dirty,
    title,
    note,
    readEditorDraft,
    save,
    markActiveDirty,
    flushActiveDraft,
  };
}
