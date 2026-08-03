import { lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import {
  CompressOutlined,
  DeleteOutlined,
  ExpandOutlined,
  FileAddOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { Button } from "antd";
import type { VaultNode, VaultNote } from "@/shared/api/client";
import { MarkdownEditor, type MarkdownEditorHandle } from "@/shared/ui/markdown-editor";
import type { LakeEditorHandle } from "@/shared/ui/lake-editor";
import type { NoteTab } from "./types";
import styles from "./NotesPage.module.css";

const LakeEditor = lazy(() =>
  import("@/shared/ui/lake-editor").then((m) => ({ default: m.LakeEditor })),
);
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
}: NoteEditorPaneProps) {
  const navigate = useNavigate();

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
              <div className={`${styles.headActions}${dirty ? ` ${styles.headActionsVisible}` : ""}`}>
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
              {lakeMode
                ? " · 语雀：顶部「插入双链」或正文末尾输入 [["
                : ""}
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
              />
            )}
            {!lakeMode && mdBooting && (
              <div className={styles.bootLoading}>
                <span className={styles.bootSpinner} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
