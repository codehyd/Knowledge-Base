import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DeleteOutlined,
  FileAddOutlined,
  FileTextOutlined,
  LinkOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import type { VaultNode, VaultNote } from "@/shared/api/client";
import { MarkdownEditor, type MarkdownEditorHandle } from "@/shared/ui/markdown-editor";
import {
  NoteLinkPicker,
  isNoteLinkHotkey,
  noteLinkHotkeyLabel,
} from "@/shared/ui/note-link";
import type { NoteTab } from "./types";
import { NoteShortcutsHelp } from "./NoteShortcutsHelp";
import styles from "./NotesPage.module.css";

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

function NoteBootOverlay({ visible, title }: { visible: boolean; title?: string }) {
  return (
    <div
      className={`${styles.bootLoading}${visible ? "" : ` ${styles.bootLoadingHidden}`}`}
      aria-hidden={!visible}
      aria-busy={visible}
    >
      <div className={styles.bootCard}>
        <div className={styles.bootKicker}>{title?.trim() || "笔记"}</div>
        <div className={styles.bootTitle}>正在打开…</div>
        <div className={styles.bootTrack}>
          <div className={styles.bootBar} />
        </div>
        <div className={styles.bootHint}>正在拉取笔记内容</div>
      </div>
    </div>
  );
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
  contentKey: number;
  activeInTree: VaultNode | null;
  editorRef: React.RefObject<MarkdownEditorHandle | null>;
  renderTabBar: (keyPrefix?: string) => React.ReactNode;
  onCreateNote: () => void;
  onSetTitle: (title: string) => void;
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
  contentKey,
  activeInTree,
  editorRef,
  renderTabBar,
  onCreateNote,
  onSetTitle,
  onDeleteNote,
  onSave,
  onDirtyChange,
  initialHeading = null,
}: NoteEditorPaneProps) {
  const navigate = useNavigate();
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [slowFetch, setSlowFetch] = useState(false);
  const hotkeyLabel = noteLinkHotkeyLabel(isMac());
  const mac = isMac();

  useEffect(() => {
    if (!loadingNote) {
      setSlowFetch(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowFetch(true), 180);
    return () => window.clearTimeout(timer);
  }, [loadingNote]);

  const insertNoteLink = useCallback(
    (label: string) => {
      editorRef.current?.insertWikilink(label);
      onDirtyChange(true);
      editorRef.current?.focus();
      setLinkPickerOpen(false);
    },
    [editorRef, onDirtyChange],
  );

  const closeLinkPicker = useCallback(() => {
    setLinkPickerOpen(false);
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  }, [editorRef]);

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
      {tabs.length > 0 ? renderTabBar() : null}

      {loadingNote && (activeId == null || !activeTab || !note) ? (
        <div className={styles.editorMain}>
          {slowFetch ? <NoteBootOverlay visible title="打开笔记" /> : null}
        </div>
      ) : activeId == null || !activeTab || !note ? (
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
        <div className={styles.editorMain}>
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
            <div className={styles.editorHost}>
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
            </div>
            <NoteLinkPicker
              open={linkPickerOpen}
              excludeSourceId={activeId}
              onClose={closeLinkPicker}
              onPick={(label) => insertNoteLink(label)}
            />
            <NoteShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} isMac={mac} />
          </div>
        </div>
      )}
    </div>
  );
}
