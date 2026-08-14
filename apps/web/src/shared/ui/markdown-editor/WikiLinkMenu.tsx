import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { filterWikiNotes, type WikiNoteOption } from "./wikilinks";
import styles from "./MarkdownEditor.module.css";

type Props = {
  query: string;
  notes: WikiNoteOption[];
  left: number;
  top: number;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onPick: (title: string) => void;
  onClose: () => void;
};

export function WikiLinkMenu({
  query,
  notes,
  left,
  top,
  selectedIndex,
  onSelectedIndexChange,
  onPick,
  onClose,
}: Props) {
  const items = useMemo(() => filterWikiNotes(notes, query), [notes, query]);
  const listRef = useRef<HTMLDivElement>(null);
  const lastMousePos = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (selectedIndex >= items.length) onSelectedIndexChange(0);
  }, [items.length, onSelectedIndexChange, selectedIndex]);

  useEffect(() => {
    const menu = listRef.current;
    const el = menu?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    if (!menu || !el) return;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    if (elTop < menu.scrollTop) menu.scrollTop = elTop;
    else if (elBottom > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = elBottom - menu.clientHeight;
    }
  }, [selectedIndex]);

  const hoverSelect = (index: number) => (e: ReactMouseEvent) => {
    const last = lastMousePos.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    onSelectedIndexChange(index);
  };

  const pick = (title: string) => {
    onPick(title);
    onClose();
  };

  const createLiteral = () => {
    const name = query.trim() || "笔记名";
    pick(name);
  };

  return (
    <div
      ref={listRef}
      className={styles.slashMenu}
      style={{ left, top }}
      role="listbox"
      aria-label="双链笔记"
    >
      <div className={styles.slashGroup}>双链笔记 · 回车确认</div>
      {items.length === 0 ? (
        <button
          type="button"
          data-index={0}
          className={`${styles.slashItem} ${selectedIndex === 0 ? styles.slashItemActive : ""}`}
          onMouseMove={hoverSelect(0)}
          onMouseDown={(e) => {
            e.preventDefault();
            createLiteral();
          }}
        >
          <span className={styles.slashIcon}>
            <span className={styles.slashGlyph}>[[</span>
          </span>
          <span className={styles.slashTitleCol}>
            <span className={styles.slashTitle}>创建 [[{query.trim() || "笔记名"}]]</span>
            <span className={styles.slashDesc}>库中暂无匹配，仍可作为双链写入</span>
          </span>
        </button>
      ) : (
        items.map((item, index) => (
          <button
            key={`${item.path}-${item.title}`}
            type="button"
            data-index={index}
            className={`${styles.slashItem} ${index === selectedIndex ? styles.slashItemActive : ""}`}
            onMouseMove={hoverSelect(index)}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(item.title);
            }}
          >
            <span className={styles.slashIcon}>
              <span className={styles.slashGlyph}>[[</span>
            </span>
            <span className={styles.slashTitleCol}>
              <span className={styles.slashTitle}>{item.title}</span>
              <span className={styles.slashDesc}>{item.path}</span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}

export function getFilteredWikiItems(notes: WikiNoteOption[], query: string) {
  const items = filterWikiNotes(notes, query);
  if (items.length) return items;
  const name = query.trim() || "笔记名";
  return [{ title: name, path: "", sourceId: null }] as WikiNoteOption[];
}
