import { EyeInvisibleOutlined, EyeOutlined, HighlightOutlined } from "@ant-design/icons";
import { Switch } from "antd";
import type { EntryAnnotation } from "@/shared/api/client";
import {
  anchorLabel,
  formatTime,
  isChatAnchor,
  normalizeColor,
} from "./previewHighlight";
import styles from "./TextPreviewModal.module.css";

type Props = {
  noteTab: "note" | "anchor";
  onNoteTabChange: (tab: "note" | "anchor") => void;
  showHighlights: boolean;
  onShowHighlightsChange: (value: boolean) => void;
  userNotesCount: number;
  chatAnchorsCount: number;
  paneNotes: EntryAnnotation[];
  activeAnnId: number | null;
  onFocusAnnotation: (ann: EntryAnnotation) => void;
  onScroll: () => void;
};

export function AnnotationSidebar({
  noteTab,
  onNoteTabChange,
  showHighlights,
  onShowHighlightsChange,
  userNotesCount,
  chatAnchorsCount,
  paneNotes,
  activeAnnId,
  onFocusAnnotation,
  onScroll,
}: Props) {
  return (
    <aside className={styles.notePane} onScroll={onScroll}>
      <div className={styles.notePaneHead}>
        <span className={styles.notePaneTitle}>
          <HighlightOutlined /> 标注
        </span>
        <label className={styles.highlightToggle}>
          <Switch
            size="small"
            checked={showHighlights}
            onChange={onShowHighlightsChange}
            checkedChildren={<EyeOutlined />}
            unCheckedChildren={<EyeInvisibleOutlined />}
          />
          <span>{showHighlights ? "显示高亮" : "隐藏高亮"}</span>
        </label>
      </div>
      <div className={styles.noteTabs}>
        <button
          type="button"
          className={`${styles.noteTab}${noteTab === "note" ? ` ${styles.noteTabActive}` : ""}`}
          onClick={() => onNoteTabChange("note")}
        >
          我的笔记 ({userNotesCount})
        </button>
        <button
          type="button"
          className={`${styles.noteTab}${noteTab === "anchor" ? ` ${styles.noteTabActive}` : ""}`}
          onClick={() => onNoteTabChange("anchor")}
        >
          对话预笔记 ({chatAnchorsCount})
        </button>
      </div>
      {paneNotes.length === 0 ? (
        <p className={styles.noteEmpty}>
          {noteTab === "anchor"
            ? "对话引用定位会出现在这里；确认后才会进入「我的笔记」。"
            : "划选正文即可添加高亮或笔记"}
        </p>
      ) : (
        <ul className={styles.noteList}>
          {paneNotes.map((ann) => (
            <li key={ann.id}>
              <button
                type="button"
                className={`${styles.noteItem}${
                  activeAnnId === ann.id ? ` ${styles.noteItemActive}` : ""
                }${isChatAnchor(ann) ? ` ${styles.noteItemAnchor}` : ""}`}
                onClick={() => void onFocusAnnotation(ann)}
              >
                <span
                  className={styles.noteDot}
                  style={{ background: normalizeColor(ann.color) }}
                />
                <div className={styles.noteBody}>
                  {isChatAnchor(ann) ? (
                    <>
                      <strong>{anchorLabel(ann)}</strong>
                      <p className={styles.noteMuted}>
                        {ann.quote.slice(0, 48)}
                        {ann.quote.length > 48 ? "…" : ""}
                      </p>
                      <em>预笔记 · 需确认才加入正式笔记</em>
                    </>
                  ) : (
                    <>
                      <strong>
                        {ann.quote.slice(0, 48)}
                        {ann.quote.length > 48 ? "…" : ""}
                      </strong>
                      {ann.note ? <p>{ann.note}</p> : <p className={styles.noteMuted}>仅高亮</p>}
                      <em>{formatTime(ann.created_at)}</em>
                    </>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
