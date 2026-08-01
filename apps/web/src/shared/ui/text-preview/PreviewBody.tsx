import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { Alert, Button, Typography } from "antd";
import type { PreviewSearchHit } from "./types";
import styles from "./TextPreviewModal.module.css";

type Props = {
  bodyRef: RefObject<HTMLDivElement | null>;
  html: string;
  fontSize: number;
  fontWeight: number;
  reselectMode: boolean;
  loading: boolean;
  edgeHint: "up" | "down" | null;
  canUp: boolean;
  canDown: boolean;
  notesEnabled: boolean;
  currentPage: number;
  totalPages: number;
  charCount: number;
  userNotesCount: number;
  chatAnchorsCount: number;
  resumedHint: boolean;
  hits: PreviewSearchHit[];
  pageOffset: number;
  globalIndex: number;
  onScroll: () => void;
  onMouseUp: (e: ReactMouseEvent) => void;
  onClick: (e: ReactMouseEvent) => void;
  onDoubleClick: (e: ReactMouseEvent) => void;
  onCancelReselect: () => void;
  onJumpToHit: (hit: PreviewSearchHit, indexInPage: number) => void;
  children?: React.ReactNode;
};

export function PreviewBody({
  bodyRef,
  html,
  fontSize,
  fontWeight,
  reselectMode,
  loading,
  edgeHint,
  canUp,
  canDown,
  notesEnabled,
  currentPage,
  totalPages,
  charCount,
  userNotesCount,
  chatAnchorsCount,
  resumedHint,
  hits,
  pageOffset,
  globalIndex,
  onScroll,
  onMouseUp,
  onClick,
  onDoubleClick,
  onCancelReselect,
  onJumpToHit,
  children,
}: Props) {
  const listStart = pageOffset;
  const showHits = hits.slice(0, 12);

  return (
    <>
      <Typography.Paragraph type="secondary" className={styles.meta}>
        <span className={styles.pageBadge}>
          第 {currentPage} / {totalPages} 页
        </span>
        共 {charCount.toLocaleString()} 字
        {notesEnabled ? ` · 笔记 ${userNotesCount}` : ""}
        {notesEnabled && chatAnchorsCount > 0 ? ` · 预笔记 ${chatAnchorsCount}` : ""}
        {resumedHint ? " · 已回到上次阅读位置" : ""}
        {loading ? " · 加载中…" : ""}
      </Typography.Paragraph>

      <div className={notesEnabled ? styles.mainSplit : undefined}>
        <div className={styles.bodyWrap}>
          {reselectMode ? (
            <Alert
              className={styles.reselectBanner}
              type="info"
              showIcon
              message="正在重新划选高亮范围"
              description="在下方正文中按住鼠标拖选一段文字（最多 2000 字）。松手后会回到编辑窗口。"
              action={
                <Button size="small" onClick={onCancelReselect}>
                  取消划选
                </Button>
              }
            />
          ) : null}
          {canUp ? (
            <div
              className={`${styles.edgeHint}${edgeHint === "up" ? ` ${styles.edgeActive}` : ""}`}
            >
              {loading && edgeHint === "up" ? "正在加载上文…" : "↑ 继续上滑加载上文"}
            </div>
          ) : (
            <div className={styles.edgeHint}>已到第一页</div>
          )}
          <div
            ref={bodyRef}
            className={`${styles.body}${reselectMode ? ` ${styles.bodyReselect}` : ""}`}
            style={{ fontSize: `${fontSize}px`, fontWeight }}
            onScroll={onScroll}
            onMouseUp={onMouseUp}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            dangerouslySetInnerHTML={{ __html: html || "暂无正文" }}
          />
          {canDown ? (
            <div
              className={`${styles.edgeHint}${edgeHint === "down" ? ` ${styles.edgeActive}` : ""}`}
            >
              {loading && edgeHint === "down" ? "正在加载下文…" : "↓ 继续下滑加载下文"}
            </div>
          ) : (
            <div className={styles.edgeHint}>已到最后一页</div>
          )}
        </div>
        {children}
      </div>

      {hits.length > 0 && (
        <div className={styles.hitList}>
          {showHits.map((hit, i) => {
            const global = listStart + i;
            return (
              <button
                key={`${hit.offset}-${global}`}
                type="button"
                className={`${styles.hitItem}${
                  global === globalIndex ? ` ${styles.hitItemActive}` : ""
                }`}
                onClick={() => void onJumpToHit(hit, i)}
              >
                <span>#{global + 1}</span>
                <em>{hit.snippet}</em>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
