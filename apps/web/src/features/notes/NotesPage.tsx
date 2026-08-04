import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { App } from "antd";
import { ConfirmDialog, confirmDialogStyles } from "@/shared/ui/ConfirmDialog";
import { findNote } from "./types";
import { useNoteTabs } from "./hooks/useNoteTabs";
import { useVaultTree, type VaultBridge } from "./hooks/useVaultTree";
import { useNoteEditor } from "./hooks/useNoteEditor";
import { VaultTree } from "./VaultTree";
import { NoteTabBar } from "./NoteTabBar";
import { NoteEditorPane } from "./NoteEditorPane";
import { NoteContextMenu, openCtxMenuAt } from "./NoteContextMenu";
import type { CtxMenuState } from "./types";
import styles from "./NotesPage.module.css";

export function NotesPage() {
  const { message, modal } = App.useApp();
  const [params, setParams] = useSearchParams();
  const readEditorDraftRef = useRef(() => ({ content: "", lake: null as string | null }));
  const lakeModeRef = useRef(false);
  const bridgeRef = useRef<VaultBridge>({
    openNote: async () => {},
    removeTab: () => {},
    tabsRef: { current: [] },
    setTabs: () => {},
  });

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  const vault = useVaultTree({ message, modal, bridgeRef });

  const tabsHook = useNoteTabs({
    message,
    setParams,
    refreshTree: vault.refreshTree,
    selectedFolder: vault.selectedFolder,
    params,
    readEditorDraft: () => readEditorDraftRef.current(),
    lakeModeRef,
  });

  bridgeRef.current = {
    openNote: tabsHook.openNote,
    removeTab: tabsHook.removeTab,
    tabsRef: tabsHook.tabsRef,
    setTabs: tabsHook.setTabs,
  };

  const editor = useNoteEditor({
    message,
    activeId: tabsHook.activeId,
    activeTab: tabsHook.activeTab,
    tabsRef: tabsHook.tabsRef,
    setTabs: tabsHook.setTabs,
    refreshTree: vault.refreshTree,
    flushActiveDraft: tabsHook.flushActiveDraft,
    markActiveDirty: tabsHook.markActiveDirty,
    resetActiveTabFromServer: tabsHook.resetActiveTabFromServer,
    setContentKey: tabsHook.setContentKey,
    setUnsavedConfirm: tabsHook.setUnsavedConfirm,
  });

  readEditorDraftRef.current = editor.readEditorDraft;
  lakeModeRef.current = editor.lakeMode;

  // 同笔记切换标题锚点时不重挂载编辑器，需主动滚到标题
  const headingParam = params.get("heading");
  useEffect(() => {
    if (!headingParam || editor.lakeMode) return;
    const timer = window.setTimeout(() => {
      try {
        editor.editorRef.current?.scrollToHeading(headingParam);
      } catch (err) {
        console.warn("[notes] scrollToHeading", err);
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [headingParam, editor.lakeMode, editor.editorRef, tabsHook.activeId, tabsHook.contentKey]);

  const activeInTree =
    tabsHook.activeId != null ? findNote(vault.nodes, tabsHook.activeId) : null;

  const handleContextMenu = useCallback((event: MouseEvent, target: CtxMenuState["target"]) => {
    setCtxMenu(openCtxMenuAt(event, target));
  }, []);

  const runCtxAction = useCallback(
    (action: string) => {
      if (!ctxMenu) return;
      const { target } = ctxMenu;
      setCtxMenu(null);
      if (target.kind === "root") {
        if (action === "newNote") void vault.onCreateNote("");
        if (action === "newFolder") vault.onCreateFolder("");
        return;
      }
      if (target.kind === "folder") {
        if (action === "newNote") {
          vault.setSelectedFolder(target.path);
          void vault.onCreateNote(target.path);
        }
        if (action === "newFolder") {
          vault.setSelectedFolder(target.path);
          vault.onCreateFolder(target.path);
        }
        if (action === "rename") vault.onRenameNode(target.path, "folder", target.name);
        if (action === "delete") vault.onDeleteFolder(target.path);
        return;
      }
      if (action === "open" && target.sourceId != null) {
        void tabsHook.openNote(target.sourceId);
      }
      if (action === "rename") {
        vault.onRenameNode(target.path, "note", target.title || target.name);
      }
      if (action === "delete") {
        if (target.sourceId != null) {
          vault.onDeleteNote(target.sourceId, target.title || target.name);
        } else {
          vault.onDeleteNote(null, target.title || target.name, {
            path: target.path,
            orphan: true,
          });
        }
      }
    },
    [ctxMenu, tabsHook, vault],
  );

  const confirmUnsaved = useCallback(() => {
    if (!tabsHook.unsavedConfirm) return;
    const action = tabsHook.unsavedConfirm;
    tabsHook.setUnsavedConfirm(null);
    if (action.type === "switch") {
      editor.applyLakeMode(action.next);
      return;
    }
    tabsHook.removeTab(action.sourceId);
  }, [editor, tabsHook]);

  const renderTabBar = useCallback(
    (keyPrefix = "") => (
      <NoteTabBar
        keyPrefix={keyPrefix}
        tabs={tabsHook.tabs}
        activeId={tabsHook.activeId}
        draggingTabId={tabsHook.draggingTabId}
        dragOver={tabsHook.dragOver}
        tabDragMovedRef={tabsHook.tabDragMovedRef}
        onActivateTab={tabsHook.activateTab}
        onCloseTab={tabsHook.closeTab}
        onReorderTabs={tabsHook.reorderTabs}
        onDragStart={tabsHook.setDraggingTabId}
        onDragOverTab={(id, side) => {
          tabsHook.setDragOver((prev) =>
            prev?.id === id && prev.side === side ? prev : { id, side },
          );
        }}
        onClearDrag={tabsHook.clearTabDrag}
        setDragOver={tabsHook.setDragOver}
      />
    ),
    [tabsHook],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (ctxMenu != null) {
        event.preventDefault();
        setCtxMenu(null);
        return;
      }
      if (vault.renameConfirm != null && !vault.renaming) {
        event.preventDefault();
        vault.setRenameConfirm(null);
        return;
      }
      if (tabsHook.unsavedConfirm != null) {
        event.preventDefault();
        tabsHook.setUnsavedConfirm(null);
        return;
      }
      if (vault.deleteConfirm != null && !vault.deleting) {
        event.preventDefault();
        vault.setDeleteConfirm(null);
        return;
      }
      if (editor.lakeMode && editor.lakeFocus) {
        event.preventDefault();
        editor.setLakeFocusRemembered(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    ctxMenu,
    editor,
    tabsHook.unsavedConfirm,
    tabsHook.setUnsavedConfirm,
    vault.deleteConfirm,
    vault.deleting,
    vault.renameConfirm,
    vault.renaming,
    vault.setDeleteConfirm,
    vault.setRenameConfirm,
  ]);

  return (
    <section className={styles.page}>
      <div className={styles.layout}>
        <VaultTree
          nodes={vault.nodes}
          loadingTree={vault.loadingTree}
          expanded={vault.expanded}
          selectedFolder={vault.selectedFolder}
          tabs={tabsHook.tabs}
          activeId={tabsHook.activeId}
          onCreateFolder={() => vault.onCreateFolder()}
          onCreateNote={() => void vault.onCreateNote()}
          onSelectRoot={() => vault.setSelectedFolder("")}
          onToggleFolder={vault.toggleFolder}
          onSelectNote={vault.selectNote}
          onContextMenu={handleContextMenu}
        />

        <NoteEditorPane
          tabs={tabsHook.tabs}
          activeId={tabsHook.activeId}
          activeTab={tabsHook.activeTab}
          note={editor.note}
          title={editor.title}
          dirty={editor.dirty}
          saving={editor.saving}
          loadingNote={tabsHook.loadingNote}
          lakeMode={editor.lakeMode}
          lakeFocus={editor.lakeFocus}
          mdBooting={editor.mdBooting}
          contentKey={tabsHook.contentKey}
          activeInTree={activeInTree}
          editorRef={editor.editorRef}
          lakeRef={editor.lakeRef}
          renderTabBar={renderTabBar}
          onCreateNote={() => void vault.onCreateNote()}
          onSetTitle={tabsHook.setActiveTitle}
          onToggleLakeMode={editor.onToggleLakeMode}
          onSetLakeFocus={editor.setLakeFocusRemembered}
          onDeleteNote={vault.onDeleteNote}
          onSave={editor.save}
          onDirtyChange={editor.markActiveDirty}
          initialHeading={params.get("heading")}
        />
      </div>

      <NoteContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} onAction={runCtxAction} />

      <ConfirmDialog
        open={vault.renameConfirm != null}
        titleId="rename-confirm-title"
        title={vault.renameConfirm?.kind === "folder" ? "重命名文件夹" : "重命名笔记"}
        maskCloseDisabled={vault.renaming}
        onMaskClick={() => vault.setRenameConfirm(null)}
        actions={
          <>
            <button
              type="button"
              className={confirmDialogStyles.ghostBtn}
              disabled={vault.renaming}
              onClick={() => vault.setRenameConfirm(null)}
            >
              取消
            </button>
            <button
              type="button"
              className={confirmDialogStyles.primaryBtn}
              disabled={vault.renaming}
              onClick={() => void vault.confirmRename()}
            >
              {vault.renaming ? "重命名中…" : "重命名"}
            </button>
          </>
        }
      >
        <input
          ref={vault.renameInputRef}
          className={confirmDialogStyles.confirmInput}
          value={vault.renameConfirm?.name ?? ""}
          disabled={vault.renaming}
          placeholder={vault.renameConfirm?.kind === "folder" ? "文件夹名称" : "笔记标题"}
          onChange={(e) =>
            vault.setRenameConfirm((prev) => (prev ? { ...prev, name: e.target.value } : prev))
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void vault.confirmRename();
            }
          }}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={tabsHook.unsavedConfirm != null}
        titleId="unsaved-confirm-title"
        title="有未保存的更改"
        onMaskClick={() => tabsHook.setUnsavedConfirm(null)}
        actions={
          <>
            <button
              type="button"
              className={confirmDialogStyles.ghostBtn}
              onClick={() => tabsHook.setUnsavedConfirm(null)}
            >
              取消
            </button>
            <button type="button" className={confirmDialogStyles.primaryBtn} onClick={confirmUnsaved}>
              继续
            </button>
          </>
        }
      >
        {tabsHook.unsavedConfirm?.type === "switch"
          ? "切换编辑器将丢失未保存内容，是否继续？"
          : "关闭标签将丢失未保存内容，是否继续？"}
      </ConfirmDialog>

      <ConfirmDialog
        open={vault.deleteConfirm != null}
        titleId="delete-confirm-title"
        title={vault.deleteConfirm?.orphan ? "删除残留文件？" : "删除笔记？"}
        maskCloseDisabled={vault.deleting}
        onMaskClick={() => vault.setDeleteConfirm(null)}
        actions={
          <>
            <button
              type="button"
              className={confirmDialogStyles.ghostBtn}
              disabled={vault.deleting}
              onClick={() => vault.setDeleteConfirm(null)}
            >
              取消
            </button>
            <button
              type="button"
              className={confirmDialogStyles.dangerBtn}
              disabled={vault.deleting}
              onClick={() => void vault.confirmDeleteNote()}
            >
              {vault.deleting ? "删除中…" : "删除"}
            </button>
          </>
        }
      >
        <p className={confirmDialogStyles.confirmLead}>
          将永久删除「{vault.deleteConfirm?.noteTitle}」，不可恢复。具体包括：
        </p>
        <ul className={confirmDialogStyles.confirmPoints}>
          {vault.deleteConfirm?.orphan ? (
            <>
              <li>笔记库中的残留文件（.md / .lake）</li>
              <li>不会再出现在侧栏；知识库若仍有条目请另行清理</li>
            </>
          ) : (
            <>
              <li>笔记库中的文件（.md 与语雀 .lake）</li>
              <li>知识库中已入库的对应条目与检索切片</li>
              <li>喂养来源记录与本地 uploads 缓存</li>
            </>
          )}
        </ul>
      </ConfirmDialog>
    </section>
  );
}
