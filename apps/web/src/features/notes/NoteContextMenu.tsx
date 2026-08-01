import { useEffect, useRef, type MouseEvent } from "react";
import type { CtxMenuState } from "./types";
import styles from "./NotesPage.module.css";

export type NoteContextMenuProps = {
  menu: CtxMenuState | null;
  onClose: () => void;
  onAction: (action: string) => void;
};

export function NoteContextMenu({ menu, onClose, onAction }: NoteContextMenuProps) {
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    const onPointer = (event: globalThis.MouseEvent) => {
      if (ctxMenuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onScroll = () => close();
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu, onClose]);

  if (menu == null) return null;

  return (
    <div
      ref={ctxMenuRef}
      className={styles.ctxMenu}
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.target.kind === "root" ? (
        <>
          <button type="button" className={styles.ctxItem} role="menuitem" onClick={() => onAction("newNote")}>
            新建笔记
          </button>
          <button type="button" className={styles.ctxItem} role="menuitem" onClick={() => onAction("newFolder")}>
            新建文件夹
          </button>
        </>
      ) : null}
      {menu.target.kind === "folder" ? (
        <>
          <button type="button" className={styles.ctxItem} role="menuitem" onClick={() => onAction("newNote")}>
            新建笔记
          </button>
          <button type="button" className={styles.ctxItem} role="menuitem" onClick={() => onAction("newFolder")}>
            新建文件夹
          </button>
          <div className={styles.ctxSep} role="separator" />
          <button type="button" className={styles.ctxItem} role="menuitem" onClick={() => onAction("rename")}>
            重命名
          </button>
          <div className={styles.ctxSep} role="separator" />
          <button
            type="button"
            className={`${styles.ctxItem} ${styles.ctxDanger}`}
            role="menuitem"
            onClick={() => onAction("delete")}
          >
            删除
          </button>
        </>
      ) : null}
      {menu.target.kind === "note" ? (
        <>
          <button
            type="button"
            className={styles.ctxItem}
            role="menuitem"
            disabled={menu.target.sourceId == null}
            onClick={() => onAction("open")}
          >
            打开
          </button>
          <button type="button" className={styles.ctxItem} role="menuitem" onClick={() => onAction("rename")}>
            重命名
          </button>
          <div className={styles.ctxSep} role="separator" />
          <button
            type="button"
            className={`${styles.ctxItem} ${styles.ctxDanger}`}
            role="menuitem"
            onClick={() => onAction("delete")}
          >
            删除
          </button>
        </>
      ) : null}
    </div>
  );
}

export function openCtxMenuAt(
  event: MouseEvent,
  target: CtxMenuState["target"],
): CtxMenuState {
  event.preventDefault();
  event.stopPropagation();
  const pad = 8;
  const menuW = 188;
  const menuH = target.kind === "note" ? 168 : target.kind === "folder" ? 196 : 100;
  const x = Math.min(event.clientX, window.innerWidth - menuW - pad);
  const y = Math.min(event.clientY, window.innerHeight - menuH - pad);
  return { x: Math.max(pad, x), y: Math.max(pad, y), target };
}
