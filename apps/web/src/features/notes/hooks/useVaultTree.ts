import { createElement, useCallback, useEffect, useRef } from "react";
import { Input, Modal } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { ModalStaticFunctions } from "antd/es/modal/confirm";
import type { SetURLSearchParams } from "react-router-dom";
import { api, type VaultNode } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import {
  useNotesStore,
  type DeleteConfirm,
  type RenameConfirm,
} from "../store/notesStore";

export type { RenameConfirm, DeleteConfirm };

export type UseVaultTreeOptions = {
  message: MessageInstance;
  modal: Omit<ModalStaticFunctions, "warn">;
  setParams: SetURLSearchParams;
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
      createElement("li", null, "文件夹内全部笔记文件（.md）与内嵌图片"),
      createElement("li", null, "对应的知识库条目与检索切片"),
      createElement("li", null, "相关喂养来源与本地 uploads 缓存"),
    ),
  );
}

export function useVaultTree({ message, modal, setParams }: UseVaultTreeOptions) {
  const nodes = useNotesStore((s) => s.nodes);
  const expanded = useNotesStore((s) => s.expanded);
  const selectedFolder = useNotesStore((s) => s.selectedFolder);
  const loadingTree = useNotesStore((s) => s.loadingTree);
  const renameConfirm = useNotesStore((s) => s.renameConfirm);
  const renaming = useNotesStore((s) => s.renaming);
  const deleteConfirm = useNotesStore((s) => s.deleteConfirm);
  const deleting = useNotesStore((s) => s.deleting);

  const setSelectedFolder = useNotesStore((s) => s.setSelectedFolder);
  const setRenameConfirm = useNotesStore((s) => s.setRenameConfirm);
  const setDeleteConfirm = useNotesStore((s) => s.setDeleteConfirm);
  const setExpanded = useNotesStore((s) => s.setExpanded);
  const toggleFolder = useNotesStore((s) => s.toggleFolder);
  const refreshTree = useNotesStore((s) => s.refreshTree);
  const openNote = useNotesStore((s) => s.openNote);
  const removeTab = useNotesStore((s) => s.removeTab);
  const patchTabAfterRename = useNotesStore((s) => s.patchTabAfterRename);
  const tabsUnderPath = useNotesStore((s) => s.tabsUnderPath);
  const setRenaming = useNotesStore((s) => s.setRenaming);
  const setDeleting = useNotesStore((s) => s.setDeleting);

  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refreshTree(message);
  }, [message, refreshTree]);

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
            await refreshTree(message);
            message.success("已创建文件夹");
          } catch (err) {
            message.error(formatError(err));
            throw err;
          }
        },
      });
    },
    [message, refreshTree, selectedFolder, setExpanded],
  );

  const onCreateNote = useCallback(
    async (parent = selectedFolder) => {
      try {
        const res = await api.createVaultNote({
          parent,
          title: "未命名笔记",
        });
        if (parent) setExpanded((s) => new Set(s).add(parent));
        await openNote(res.source_id, { message, setParams, note: res });
        void refreshTree(message);
      } catch (err) {
        message.error(formatError(err));
      }
    },
    [message, openNote, refreshTree, selectedFolder, setExpanded, setParams],
  );

  const onRenameNode = useCallback(
    (nodePath: string, kind: "note" | "folder", currentName: string) => {
      setRenameConfirm({
        path: nodePath,
        kind,
        name: currentName.replace(/\.md$/i, ""),
      });
    },
    [setRenameConfirm],
  );

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
      await refreshTree(message);
      if (renameConfirm.kind === "note") {
        patchTabAfterRename(renameConfirm.path, patched.path, next);
      }
      setRenameConfirm(null);
      message.success("已重命名");
    } catch (err) {
      message.error(formatError(err));
    } finally {
      setRenaming(false);
    }
  }, [
    message,
    patchTabAfterRename,
    refreshTree,
    renameConfirm,
    renaming,
    setRenameConfirm,
    setRenaming,
  ]);

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
    [setDeleteConfirm],
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
        removeTab(sourceId, setParams);
      } else if (path) {
        await api.deleteVaultPath(path);
      } else {
        throw new Error("无法删除：缺少笔记标识");
      }
      await refreshTree(message);
      setDeleteConfirm(null);
      message.success("已删除");
    } catch (err) {
      message.error(formatError(err));
    } finally {
      setDeleting(false);
    }
  }, [
    deleteConfirm,
    deleting,
    message,
    refreshTree,
    removeTab,
    setDeleteConfirm,
    setDeleting,
    setParams,
  ]);

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
          for (const t of tabsUnderPath(path)) {
            removeTab(t.sourceId, setParams);
          }
          await refreshTree(message);
          message.success("已删除文件夹");
        },
      });
    },
    [
      message,
      modal,
      refreshTree,
      removeTab,
      selectedFolder,
      setParams,
      setSelectedFolder,
      tabsUnderPath,
    ],
  );

  const selectNote = useCallback(
    (node: VaultNode) => {
      if (node.source_id == null) {
        void (async () => {
          try {
            const res = await api.registerVaultPath(node.path);
            await refreshTree(message);
            await openNote(res.source_id, { message, setParams });
            message.success("已重新关联到笔记库");
          } catch (err) {
            message.error(formatError(err));
          }
        })();
        return;
      }
      void openNote(node.source_id, { message, setParams });
    },
    [message, openNote, refreshTree, setParams],
  );

  return {
    nodes,
    expanded,
    selectedFolder,
    setSelectedFolder,
    loadingTree,
    refreshTree: () => refreshTree(message),
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
