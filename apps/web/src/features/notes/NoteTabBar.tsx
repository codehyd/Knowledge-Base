import { CloseOutlined, FileTextOutlined } from "@ant-design/icons";
import type { NoteTab } from "./types";
import styles from "./NotesPage.module.css";

export type NoteTabBarProps = {
  tabs: NoteTab[];
  activeId: number | null;
  keyPrefix?: string;
  draggingTabId: number | null;
  dragOver: { id: number; side: "before" | "after" } | null;
  tabDragMovedRef: React.RefObject<boolean>;
  onActivateTab: (sourceId: number) => void;
  onCloseTab: (sourceId: number) => void;
  onReorderTabs: (fromId: number, toId: number, side: "before" | "after") => void;
  onDragStart: (sourceId: number) => void;
  onDragOverTab: (id: number, side: "before" | "after") => void;
  onClearDrag: () => void;
  setDragOver: React.Dispatch<
    React.SetStateAction<{ id: number; side: "before" | "after" } | null>
  >;
};

export function NoteTabBar({
  tabs,
  activeId,
  keyPrefix = "",
  draggingTabId,
  dragOver,
  tabDragMovedRef,
  onActivateTab,
  onCloseTab,
  onReorderTabs,
  onDragStart,
  onDragOverTab,
  onClearDrag,
  setDragOver,
}: NoteTabBarProps) {
  return (
    <div
      className={styles.tabBar}
      role="tablist"
      aria-label="已打开的笔记"
      onDragOver={(e) => {
        if (draggingTabId == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const fromId = Number(e.dataTransfer.getData("text/kongku-tab") || draggingTabId);
        if (!Number.isNaN(fromId) && dragOver) {
          onReorderTabs(fromId, dragOver.id, dragOver.side);
        }
        onClearDrag();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(null);
        }
      }}
    >
      {tabs.map((tab) => {
        const active = tab.sourceId === activeId;
        const isDragging = draggingTabId === tab.sourceId;
        const overBefore = dragOver?.id === tab.sourceId && dragOver.side === "before";
        const overAfter = dragOver?.id === tab.sourceId && dragOver.side === "after";
        return (
          <div
            key={`${keyPrefix}${tab.sourceId}`}
            className={`${styles.tab}${active ? ` ${styles.tabActive}` : ""}${
              tab.dirty ? ` ${styles.tabDirty}` : ""
            }${isDragging ? ` ${styles.tabDragging}` : ""}${
              overBefore ? ` ${styles.tabDropBefore}` : ""
            }${overAfter ? ` ${styles.tabDropAfter}` : ""}`}
            role="tab"
            aria-selected={active}
            title={tab.path || tab.draftTitle}
            draggable
            onDragStart={(e) => {
              tabDragMovedRef.current = false;
              onDragStart(tab.sourceId);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/kongku-tab", String(tab.sourceId));
              e.dataTransfer.setData("text/plain", String(tab.sourceId));
              if (e.currentTarget instanceof HTMLElement) {
                requestAnimationFrame(() => {
                  e.currentTarget.classList.add(styles.tabDragging);
                });
              }
            }}
            onDrag={(e) => {
              if (Math.abs(e.movementX) + Math.abs(e.movementY) > 0) {
                tabDragMovedRef.current = true;
              }
            }}
            onDragEnd={() => {
              onClearDrag();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (draggingTabId == null || draggingTabId === tab.sourceId) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const side = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
              onDragOverTab(tab.sourceId, side);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const fromId = Number(e.dataTransfer.getData("text/kongku-tab") || draggingTabId);
              const rect = e.currentTarget.getBoundingClientRect();
              const side = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
              if (!Number.isNaN(fromId)) {
                onReorderTabs(fromId, tab.sourceId, side);
              }
              onClearDrag();
            }}
            onClick={() => {
              if (tabDragMovedRef.current) {
                tabDragMovedRef.current = false;
                return;
              }
              onActivateTab(tab.sourceId);
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onCloseTab(tab.sourceId);
              }
            }}
          >
            <FileTextOutlined className={styles.tabIcon} />
            <span className={styles.tabLabel}>{tab.draftTitle || tab.title || "无标题"}</span>
            {tab.dirty ? <span className={styles.tabDot} aria-label="未保存" /> : null}
            <button
              type="button"
              className={styles.tabClose}
              title="关闭"
              aria-label={`关闭 ${tab.draftTitle || tab.title}`}
              draggable={false}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.sourceId);
              }}
            >
              <CloseOutlined />
            </button>
          </div>
        );
      })}
    </div>
  );
}
