import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CompressOutlined,
  DeleteOutlined,
  ExpandOutlined,
  FileAddOutlined,
  FileTextOutlined,
  LinkOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import type { VaultNode, VaultNote } from "@/shared/api/client";
import { MarkdownEditor, type MarkdownEditorHandle } from "@/shared/ui/markdown-editor";
import type { LakeEditorHandle } from "@/shared/ui/lake-editor";
import {
  NoteLinkPicker,
  isNoteLinkHotkey,
  noteLinkHotkeyLabel,
} from "@/shared/ui/note-link";
import type { NoteTab } from "./types";
import { NoteShortcutsHelp } from "./NoteShortcutsHelp";
import styles from "./NotesPage.module.css";

const LakeEditor = lazy(() =>
  import("@/shared/ui/lake-editor").then((m) => ({ default: m.LakeEditor })),
);

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export type NoteEditorPaneProps = {
  tabs: NoteTab[];
  activeId: number | null;
  activeTab: NoteTab | null;
  note: VaultNote | null;
  title: string;
  dirty: boolean;
  saving: boolean;
  loadingNote: boolean;
  lakeMode: boolean;
  lakeFocus: boolean;
  mdBooting: boolean;
  contentKey: number;
  activeInTree: VaultNode | null;
  editorRef: React.RefObject<MarkdownEditorHandle | null>;
  lakeRef: React.RefObject<LakeEditorHandle | null>;
  renderTabBar: (keyPrefix?: string) => React.ReactNode;
  onCreateNote: () => void;
  onSetTitle: (title: string) => void;
  onToggleLakeMode: (next: boolean) => void;
  onSetLakeFocus: (next: boolean) => void;
  onDeleteNote: (sourceId: number, title: string) => void;
  onSave: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** URL ?heading= 打开时滚到标题 */
  initialHeading?: string | null;
};

export function NoteEditorPane({
  tabs,
  activeId,
  activeTab,
  note,
  title,
  dirty,
  saving,
  loadingNote,
  lakeMode,
  lakeFocus,
  mdBooting,
  contentKey,
  activeInTree,
  editorRef,
  lakeRef,
  renderTabBar,
  onCreateNote,
  onSetTitle,
  onToggleLakeMode,
  onSetLakeFocus,
  onDeleteNote,
  onSave,
  onDirtyChange,
  initialHeading = null,
}: NoteEditorPaneProps) {
  const navigate = useNavigate();
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const hotkeyLabel = noteLinkHotkeyLabel(isMac());
  const mac = isMac();

  const insertNoteLink = useCallback(
    (label: string) => {
      const text = `[[${label}]]`;
      if (lakeMode) {
        lakeRef.current?.insertText(text);
        onDirtyChange(true);
        lakeRef.current?.focus();
      } else {
        editorRef.current?.insertWikilink(label);
        onDirtyChange(true);
        editorRef.current?.focus();
      }
      setLinkPickerOpen(false);
    },
    [editorRef, lakeMode, lakeRef, onDirtyChange],
  );

  const closeLinkPicker = useCallback(() => {
    setLinkPickerOpen(false);
    window.requestAnimationFrame(() => {
      if (lakeMode) lakeRef.current?.focus();
      else editorRef.current?.focus();
    });
  }, [editorRef, lakeMode, lakeRef]);

  useEffect(() => {
    if (activeId == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isNoteLinkHotkey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setLinkPickerOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeId]);

  return (
    <div className={styles.editorPane}>
      {tabs.length > 0 && !(lakeMode && lakeFocus && activeTab) ? renderTabBar() : null}

      {activeId == null || !activeTab || !note ? (
        <div className={styles.emptyEditor}>
          <FileTextOutlined style={{ fontSize: 36, opacity: 0.35 }} />
          <div>选择左侧笔记，或新建一篇开始写</div>
          <Button type="primary" icon={<FileAddOutlined />} onClick={() => void onCreateNote()}>
            新建笔记
          </Button>
          <Button type="link" onClick={() => navigate("/knowledge")}>
            回知识浏览
          </Button>
        </div>
      ) : (
        <div className={`${styles.editorMain}${lakeMode && lakeFocus ? ` ${styles.lakeCover}` : ""}`}>
          {lakeMode && lakeFocus && tabs.length > 0 ? renderTabBar("cover-") : null}
          <div className={styles.editorHead}>
            <div className={styles.editorHeadRow}>
              <input
                className={styles.titleInput}
                value={title}
                onChange={(e) => onSetTitle(e.target.value)}
                placeholder="无标题"
                aria-label="笔记标题"
              />
              <div className={styles.headHelp}>
                <Tooltip title="快捷键帮助">
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label="快捷键帮助"
                    onClick={() => setHelpOpen(true)}
                  >
                    <QuestionCircleOutlined />
                  </button>
                </Tooltip>
              </div>
              <div className={`${styles.headActions}${dirty ? ` ${styles.headActionsVisible}` : ""}`}>
                <Tooltip title={`插入双链（${hotkeyLabel}）`}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label="插入双链"
                    onClick={() => setLinkPickerOpen(true)}
                  >
                    <LinkOutlined />
                  </button>
                </Tooltip>
                {lakeMode && lakeFocus && (
                  <button
                    type="button"
                    className={styles.iconBtn}
                    title="退回应用界面（Esc）"
                    onClick={() => onSetLakeFocus(false)}
                  >
                    <CompressOutlined />
                  </button>
                )}
                {lakeMode && !lakeFocus && (
                  <button
                    type="button"
                    className={styles.iconBtn}
                    title="全屏编辑"
                    onClick={() => onSetLakeFocus(true)}
                  >
                    <ExpandOutlined />
                  </button>
                )}
                <span
                  className={styles.lakeSwitch}
                  title="语雀编辑器（实验）：保存时同时写 .md 和 .lake 源文件"
                >
                  <span className={styles.lakeSwitchLabel}>语雀</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={lakeMode}
                    className={`${styles.miniSwitch}${lakeMode ? ` ${styles.miniSwitchOn}` : ""}`}
                    onClick={() => onToggleLakeMode(!lakeMode)}
                  >
                    <span className={styles.miniSwitchThumb} />
                  </button>
                </span>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title="删除笔记"
                  onClick={() => onDeleteNote(activeId, title || "笔记")}
                >
                  <DeleteOutlined />
                </button>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={saving || loadingNote}
                  onClick={() => void onSave()}
                >
                  {saving || loadingNote ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
            <div className={styles.meta}>
              {note.committed ? "已入库" : "未入库"}
              {activeInTree?.path || activeTab.path
                ? ` · ${activeInTree?.path || activeTab.path}`
                : ""}
              {` · 双链 ${hotkeyLabel}`}
            </div>
          </div>
          <div className={styles.editorBody}>
            {lakeMode ? (
              <Suspense fallback={<div className={styles.bootLoading}><span className={styles.bootSpinner} /></div>}>
                <LakeEditor
                  key={`lake-${activeId}-${contentKey}`}
                  ref={lakeRef}
                  initialContent={activeTab.draftLake ?? activeTab.draftContent}
                  initialScheme={activeTab.draftLake ? "text/lake" : "text/markdown"}
                  onDirtyChange={onDirtyChange}
                  onSave={onSave}
                />
              </Suspense>
            ) : (
              <MarkdownEditor
                key={`md-${activeId}-${contentKey}`}
                ref={editorRef}
                initialMarkdown={activeTab.draftContent}
                dirty={dirty}
                onDirtyChange={onDirtyChange}
                onSave={onSave}
                saving={saving}
                excludeSourceId={activeId}
                initialHeading={initialHeading}
              />
            )}
            {!lakeMode && mdBooting && (
              <div className={styles.bootLoading}>
                <span className={styles.bootSpinner} />
              </div>
            )}
            <NoteLinkPicker
              open={linkPickerOpen}
              excludeSourceId={activeId}
              onClose={closeLinkPicker}
              onPick={(label) => insertNoteLink(label)}
            />
            <NoteShortcutsHelp
              open={helpOpen}
              onClose={() => setHelpOpen(false)}
              lakeMode={lakeMode}
              isMac={mac}
            />
          </div>
        </div>
      )}
    </div>
  );
}
