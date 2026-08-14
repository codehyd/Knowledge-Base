import { create } from "zustand";
import type { MessageInstance } from "antd/es/message/interface";
import type { SetURLSearchParams } from "react-router-dom";
import { api, type VaultNode, type VaultNote } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { extractWikilinkTargets } from "@/shared/ui/markdown-editor/wikilinks";
import { tabFromNote, type NoteTab } from "../types";

export type RenameConfirm = {
  path: string;
  kind: "note" | "folder";
  name: string;
} | null;

export type DeleteConfirm = {
  sourceId: number | null;
  path?: string;
  noteTitle: string;
  orphan?: boolean;
} | null;

export type UnsavedConfirm = { type: "closeTab"; sourceId: number } | null;

export type EditorDraft = {
  content: string;
};

/** 编辑器 DOM 句柄不进 store；由 useNoteEditor 注册 */
let readEditorDraftImpl: () => EditorDraft = () => ({ content: "" });

export function registerReadEditorDraft(fn: () => EditorDraft) {
  readEditorDraftImpl = fn;
}

function readEditorDraft() {
  return readEditorDraftImpl();
}

type NotesState = {
  // tree
  nodes: VaultNode[];
  expanded: Set<string>;
  selectedFolder: string;
  loadingTree: boolean;
  renameConfirm: RenameConfirm;
  renaming: boolean;
  deleteConfirm: DeleteConfirm;
  deleting: boolean;

  // tabs
  tabs: NoteTab[];
  activeId: number | null;
  contentKey: number;
  loadingNote: boolean;
  unsavedConfirm: UnsavedConfirm;
  draggingTabId: number | null;
  dragOver: { id: number; side: "before" | "after" } | null;

  saving: boolean;

  // tree setters / actions
  setNodes: (nodes: VaultNode[]) => void;
  setExpanded: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setSelectedFolder: (folder: string) => void;
  setLoadingTree: (loading: boolean) => void;
  setRenameConfirm: (
    next: RenameConfirm | ((prev: RenameConfirm) => RenameConfirm),
  ) => void;
  setRenaming: (v: boolean) => void;
  setDeleteConfirm: (next: DeleteConfirm) => void;
  setDeleting: (v: boolean) => void;
  toggleFolder: (path: string) => void;
  refreshTree: (message: MessageInstance) => Promise<void>;

  // tabs setters / actions
  setTabs: (updater: NoteTab[] | ((prev: NoteTab[]) => NoteTab[])) => void;
  setActiveId: (id: number | null) => void;
  setContentKey: (updater: number | ((prev: number) => number)) => void;
  setLoadingNote: (v: boolean) => void;
  setUnsavedConfirm: (next: UnsavedConfirm) => void;
  setDraggingTabId: (id: number | null) => void;
  setDragOver: (
    next:
      | { id: number; side: "before" | "after" }
      | null
      | ((
          prev: { id: number; side: "before" | "after" } | null,
        ) => { id: number; side: "before" | "after" } | null),
  ) => void;
  clearTabDrag: () => void;
  flushActiveDraft: () => void;
  activateTab: (sourceId: number, setParams: SetURLSearchParams) => void;
  removeTab: (sourceId: number, setParams: SetURLSearchParams) => void;
  closeTab: (sourceId: number, setParams: SetURLSearchParams, force?: boolean) => void;
  reorderTabs: (fromId: number, toId: number, side: "before" | "after") => void;
  openNote: (
    sourceId: number,
    deps: {
      message: MessageInstance;
      setParams: SetURLSearchParams;
      /** 已有正文时跳过再拉一遍（新建空笔记） */
      note?: VaultNote;
    },
  ) => Promise<void>;
  markActiveDirty: (dirty: boolean) => void;
  setActiveTitle: (title: string) => void;
  resetActiveTabFromServer: () => void;
  patchTabAfterRename: (oldPath: string, patchedPath: string, nextTitle: string) => void;
  tabsUnderPath: (path: string) => NoteTab[];

  setSaving: (v: boolean) => void;
  saveActiveNote: (deps: {
    message: MessageInstance;
    activeId: number;
  }) => Promise<void>;
};

export const useNotesStore = create<NotesState>((set, get) => ({
  nodes: [],
  expanded: new Set(),
  selectedFolder: "",
  loadingTree: false,
  renameConfirm: null,
  renaming: false,
  deleteConfirm: null,
  deleting: false,

  tabs: [],
  activeId: null,
  contentKey: 0,
  loadingNote: false,
  unsavedConfirm: null,
  draggingTabId: null,
  dragOver: null,

  saving: false,

  setNodes: (nodes) => set({ nodes }),
  setExpanded: (updater) =>
    set((s) => ({
      expanded: typeof updater === "function" ? updater(s.expanded) : updater,
    })),
  setSelectedFolder: (folder) => set({ selectedFolder: folder }),
  setLoadingTree: (loading) => set({ loadingTree: loading }),
  setRenameConfirm: (next) =>
    set((s) => ({
      renameConfirm: typeof next === "function" ? next(s.renameConfirm) : next,
    })),
  setRenaming: (v) => set({ renaming: v }),
  setDeleteConfirm: (next) => set({ deleteConfirm: next }),
  setDeleting: (v) => set({ deleting: v }),

  toggleFolder: (path) =>
    set((s) => {
      const next = new Set(s.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { selectedFolder: path, expanded: next };
    }),

  refreshTree: async (message) => {
    set({ loadingTree: true });
    try {
      const res = await api.getVaultTree();
      set({ nodes: res.nodes || [] });
    } catch (err) {
      message.error(formatError(err));
    } finally {
      set({ loadingTree: false });
    }
  },

  setTabs: (updater) =>
    set((s) => ({
      tabs: typeof updater === "function" ? updater(s.tabs) : updater,
    })),
  setActiveId: (id) => set({ activeId: id }),
  setContentKey: (updater) =>
    set((s) => ({
      contentKey: typeof updater === "function" ? updater(s.contentKey) : updater,
    })),
  setLoadingNote: (v) => set({ loadingNote: v }),
  setUnsavedConfirm: (next) => set({ unsavedConfirm: next }),
  setDraggingTabId: (id) => set({ draggingTabId: id }),
  setDragOver: (next) =>
    set((s) => ({
      dragOver: typeof next === "function" ? next(s.dragOver) : next,
    })),
  clearTabDrag: () => set({ draggingTabId: null, dragOver: null }),

  flushActiveDraft: () => {
    const { activeId } = get();
    if (activeId == null) return;
    const { content } = readEditorDraft();
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sourceId === activeId ? { ...t, draftContent: content } : t,
      ),
    }));
  },

  activateTab: (sourceId, setParams) => {
    if (sourceId === get().activeId) return;
    get().flushActiveDraft();
    set({ activeId: sourceId });
    setParams({ id: String(sourceId) }, { replace: true });
  },

  removeTab: (sourceId, setParams) => {
    const { tabs, activeId, contentKey } = get();
    const idx = tabs.findIndex((t) => t.sourceId === sourceId);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.sourceId !== sourceId);
    if (activeId !== sourceId) {
      set({ tabs: next });
      return;
    }
    const neighbor = next[idx] ?? next[idx - 1] ?? null;
    if (neighbor) {
      set({
        tabs: next,
        activeId: neighbor.sourceId,
        contentKey: contentKey + 1,
      });
      setParams({ id: String(neighbor.sourceId) }, { replace: true });
    } else {
      set({ tabs: next, activeId: null });
      setParams({}, { replace: true });
    }
  },

  closeTab: (sourceId, setParams, force = false) => {
    const tab = get().tabs.find((t) => t.sourceId === sourceId);
    if (!tab) return;
    if (tab.dirty && !force) {
      set({ unsavedConfirm: { type: "closeTab", sourceId } });
      return;
    }
    if (sourceId !== get().activeId) {
      get().flushActiveDraft();
    }
    get().removeTab(sourceId, setParams);
  },

  reorderTabs: (fromId, toId, side) => {
    if (fromId === toId) return;
    set((s) => {
      const fromIdx = s.tabs.findIndex((t) => t.sourceId === fromId);
      if (fromIdx < 0) return s;
      const next = [...s.tabs];
      const [item] = next.splice(fromIdx, 1);
      let toIdx = next.findIndex((t) => t.sourceId === toId);
      if (toIdx < 0) return s;
      if (side === "after") toIdx += 1;
      next.splice(toIdx, 0, item);
      return { tabs: next };
    });
  },

  openNote: async (sourceId, { message, setParams, note: preloaded }) => {
    if (get().tabs.some((t) => t.sourceId === sourceId)) {
      get().activateTab(sourceId, setParams);
      return;
    }
    const adopt = (res: VaultNote) => {
      get().flushActiveDraft();
      set((s) => {
        if (s.tabs.some((t) => t.sourceId === res.source_id)) {
          return {
            activeId: res.source_id,
            contentKey: s.contentKey + 1,
          };
        }
        return {
          tabs: [...s.tabs, tabFromNote(res)],
          activeId: res.source_id,
          contentKey: s.contentKey + 1,
        };
      });
      setParams({ id: String(res.source_id) }, { replace: true });
    };
    if (preloaded && preloaded.source_id === sourceId) {
      adopt(preloaded);
      return;
    }
    set({ loadingNote: true });
    try {
      adopt(await api.getVaultNote(sourceId));
    } catch (err) {
      message.error(formatError(err));
    } finally {
      set({ loadingNote: false });
    }
  },

  markActiveDirty: (dirty) => {
    const id = get().activeId;
    if (id == null) return;
    const tab = get().tabs.find((t) => t.sourceId === id);
    if (tab && tab.dirty === dirty) return;
    set((s) => ({
      tabs: s.tabs.map((t) => (t.sourceId === id ? { ...t, dirty } : t)),
    }));
  },

  setActiveTitle: (nextTitle) => {
    const id = get().activeId;
    if (id == null) return;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sourceId === id
          ? { ...t, draftTitle: nextTitle, title: nextTitle, dirty: true }
          : t,
      ),
    }));
  },

  resetActiveTabFromServer: () => {
    const id = get().activeId;
    if (id == null) return;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sourceId === id
          ? {
              ...t,
              draftTitle: t.note.title || "",
              draftContent: t.note.content,
              dirty: false,
            }
          : t,
      ),
    }));
  },

  patchTabAfterRename: (oldPath, patchedPath, nextTitle) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === oldPath || t.path === patchedPath
          ? {
              ...t,
              path: patchedPath,
              title: nextTitle,
              draftTitle: t.dirty ? t.draftTitle : nextTitle,
              note: { ...t.note, title: nextTitle, path: patchedPath },
            }
          : t,
      ),
    }));
  },

  tabsUnderPath: (path) =>
    get().tabs.filter((t) => t.path === path || t.path.startsWith(path + "/")),

  setSaving: (v) => set({ saving: v }),

  saveActiveNote: async ({ message, activeId }) => {
    const { tabs } = get();
    const { content } = readEditorDraft();
    const draftTitle = tabs.find((t) => t.sourceId === activeId)?.draftTitle.trim() ?? "";
    set({ saving: true });
    try {
      const res = await api.saveVaultNote(activeId, {
        title: draftTitle,
        content,
      });
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.sourceId === activeId
            ? {
                ...t,
                note: res,
                title: res.title,
                path: res.path,
                draftTitle: res.title,
                draftContent: res.content,
                dirty: false,
              }
            : t,
        ),
      }));
      const linkCount = extractWikilinkTargets(content).length;
      message.success(
        `${res.committed ? "已保存并入库" : "已保存"}${
          linkCount ? ` · 检测到 ${linkCount} 条双链` : ""
        }`,
      );
      void get().refreshTree(message);
    } catch (err) {
      message.error(formatError(err));
    } finally {
      set({ saving: false });
    }
  },
}));

export function selectActiveTab(state: NotesState): NoteTab | null {
  return state.activeId != null
    ? state.tabs.find((t) => t.sourceId === state.activeId) ?? null
    : null;
}
