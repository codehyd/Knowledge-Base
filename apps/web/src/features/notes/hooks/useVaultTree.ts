import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { Input, Modal } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { ModalStaticFunctions } from "antd/es/modal/confirm";
import { api, type VaultNode } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import type { NoteTab } from "../types";

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

export type VaultBridge = {
  openNote: (sourceId: number) => Promise<void>;
  removeTab: (sourceId: number) => void;
  tabsRef: React.RefObject<NoteTab[]>;
  setTabs: React.Dispatch<React.SetStateAction<NoteTab[]>>;
};

export type UseVaultTreeOptions = {
  message: MessageInstance;
  modal: Omit<ModalStaticFunctions, "warn">;
  bridgeRef: React.RefObject<VaultBridge>;
};

function deleteFolderConfirmContent() {
  return createElement(
    "div",
    null,
    createElement(
      "p",
      { style: { margin: "0 0 8px" } },
      "将永久删除该文件夹及其中全部内容，不可恢复。具体包括：",
    ),
    createElement(
      "ul",
      { style: { margin: 0, paddingLeft: "1.2em", color: "#475569" } },
      createElement("li", null, "文件夹内全部笔记文件（.md / .lake）"),
      createElement("li", null, "对应的知识库条目与检索切片"),
      createElement("li", null, "相关喂养来源与本地 uploads 缓存"),
    ),
  );
}

export function useVaultTree({ message, modal, bridgeRef }: UseVaultTreeOptions) {
  const [nodes, setNodes] = useState<VaultNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState("");
  const [loadingTree, setLoadingTree] = useState(false);
  const [renameConfirm, setRenameConfirm] = useState<RenameConfirm>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm>(null);
  const [deleting, setDeleting] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const refreshTree = useCallback(async () => {
    setLoadingTree(true);
    try {
      const res = await api.getVaultTree();
      setNodes(res.nodes || []);
    } catch (err) {
      message.error(formatError(err));
    } finally {
      setLoadingTree(false);
    }
  }, [message]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  useEffect(() => {
    if (!renameConfirm) return;
    const id = window.setTimeout(() => {
      const el = renameInputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, 20);
    return () => window.clearTimeout(id);
  }, [renameConfirm]);

  const onCreateFolder = useCallback(
    (parent = selectedFolder) => {
      let name = "新建文件夹";
      Modal.confirm({
        title: "新建文件夹",
        content: createElement(Input, {
          defaultValue: name,
          onChange: (e) => {
            name = e.target.value;
          },
          placeholder: "文件夹名称",
        }),
        okText: "创建",
        onOk: async () => {
          try {
            await api.createVaultFolder({ parent, name: name.trim() || "新建文件夹" });
            if (parent) setExpanded((s) => new Set(s).add(parent));
            await refreshTree();
            message.success("已创建文件夹");
          } catch (err) {
            message.error(formatError(err));
            throw err;
          }
        },
      });
    },
    [message, refreshTree, selectedFolder],
  );

  const onCreateNote = useCallback(
    async (parent = selectedFolder) => {
      try {
        const res = await api.createVaultNote({
          parent,
          title: "未命名笔记",
        });
        if (parent) setExpanded((s) => new Set(s).add(parent));
        await refreshTree();
        await bridgeRef.current.openNote(res.source_id);
      } catch (err) {
        message.error(formatError(err));
      }
    },
    [bridgeRef, message, refreshTree, selectedFolder],
  );

  const onRenameNode = useCallback((nodePath: string, kind: "note" | "folder", currentName: string) => {
    setRenameConfirm({
      path: nodePath,
      kind,
      name: currentName.replace(/\.md$/i, ""),
    });
  }, []);

  const confirmRename = useCallback(async () => {
    if (!renameConfirm || renaming) return;
    const next = renameConfirm.name.trim();
    if (!next) {
      message.error("名称不能为空");
      renameInputRef.current?.focus();
      return;
    }
    setRenaming(true);
    try {
      const patched = await api.patchVaultNode({
        path: renameConfirm.path,
        new_name: next,
      });
      await refreshTree();
      if (renameConfirm.kind === "note") {
        const oldPath = renameConfirm.path;
        const { setTabs } = bridgeRef.current;
        setTabs((prev) =>
          prev.map((t) =>
            t.path === oldPath || t.path === patched.path
              ? {
                  ...t,
                  path: patched.path,
                  title: next,
                  draftTitle: t.dirty ? t.draftTitle : next,
                  note: { ...t.note, title: next, path: patched.path },
                }
              : t,
          ),
        );
      }
      setRenameConfirm(null);
      message.success("已重命名");
    } catch (err) {
      message.error(formatError(err));
    } finally {
      setRenaming(false);
    }
  }, [bridgeRef, message, refreshTree, renameConfirm, renaming]);

  const onDeleteNote = useCallback(
    (
      sourceId: number | null,
      noteTitle: string,
      opts?: { path?: string; orphan?: boolean },
    ) => {
      setDeleteConfirm({
        sourceId,
        noteTitle,
        path: opts?.path,
        orphan: opts?.orphan,
      });
    },
    [],
  );

  const confirmDeleteNote = useCallback(async () => {
    if (!deleteConfirm || deleting) return;
    const { sourceId, path, orphan } = deleteConfirm;
    setDeleting(true);
    try {
      if (orphan && path) {
        await api.deleteVaultPath(path);
      } else if (sourceId != null) {
        await api.deleteVaultNote(sourceId);
        bridgeRef.current.removeTab(sourceId);
      } else if (path) {
        await api.deleteVaultPath(path);
      } else {
        throw new Error("无法删除：缺少笔记标识");
      }
      await refreshTree();
      setDeleteConfirm(null);
      message.success("已删除");
    } catch (err) {
      message.error(formatError(err));
    } finally {
      setDeleting(false);
    }
  }, [bridgeRef, deleteConfirm, deleting, message, refreshTree]);

  const onDeleteFolder = useCallback(
    (path: string) => {
      modal.confirm({
        title: "删除文件夹？",
        content: deleteFolderConfirmContent(),
        okText: "删除",
        okButtonProps: { danger: true },
        onOk: async () => {
          await api.deleteVaultFolder(path);
          if (selectedFolder === path || selectedFolder.startsWith(path + "/")) {
            setSelectedFolder("");
          }
          const doomed = bridgeRef.current.tabsRef.current?.filter(
            (t) => t.path === path || t.path.startsWith(path + "/"),
          ) ?? [];
          for (const t of doomed) bridgeRef.current.removeTab(t.sourceId);
          await refreshTree();
          message.success("已删除文件夹");
        },
      });
    },
    [bridgeRef, message, modal, refreshTree, selectedFolder],
  );

  const selectNote = useCallback(
    (node: VaultNode) => {
      if (node.source_id == null) {
        void (async () => {
          try {
            const res = await api.registerVaultPath(node.path);
            await refreshTree();
            await bridgeRef.current.openNote(res.source_id);
            message.success("已重新关联到笔记库");
          } catch (err) {
            message.error(formatError(err));
          }
        })();
        return;
      }
      void bridgeRef.current.openNote(node.source_id);
    },
    [bridgeRef, message, refreshTree],
  );

  const toggleFolder = useCallback((path: string) => {
    setSelectedFolder(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return {
    nodes,
    expanded,
    selectedFolder,
    setSelectedFolder,
    loadingTree,
    refreshTree,
    renameConfirm,
    setRenameConfirm,
    renaming,
    renameInputRef,
    deleteConfirm,
    setDeleteConfirm,
    deleting,
    onCreateFolder,
    onCreateNote,
    onRenameNode,
    confirmRename,
    onDeleteNote,
    confirmDeleteNote,
    onDeleteFolder,
    selectNote,
    toggleFolder,
  };
}
