import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { filterWikiNotes, type WikiNoteOption } from "@/shared/ui/markdown-editor/wikilinks";
import styles from "./LakeEditor.module.css";

type Props = {
  open: boolean;
  query: string;
  notes: WikiNoteOption[];
  mode: "insert" | "complete";
  onQueryChange: (q: string) => void;
  onPick: (title: string) => void;
  onClose: () => void;
  anchorLeft?: number;
  anchorTop?: number;
};

export function LakeWikiPicker({
  open,
  query,
  notes,
  mode,
  onQueryChange,
  onPick,
  onClose,
  anchorLeft,
  anchorTop,
}: Props) {
  const items = useMemo(() => filterWikiNotes(notes, query), [notes, query]);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastMousePos = useRef<{ x: number; y: number } | null>(null);

  const displayItems = useMemo(() => {
    if (items.length) return items;
    const name = query.trim() || "笔记名";
    return [{ title: name, path: "", sourceId: null }] as WikiNoteOption[];
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    setIndex(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (index >= displayItems.length) setIndex(0);
  }, [displayItems.length, index]);

  useEffect(() => {
    const menu = listRef.current;
    const el = menu?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!menu || !el) return;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    if (elTop < menu.scrollTop) menu.scrollTop = elTop;
    else if (elBottom > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = elBottom - menu.clientHeight;
    }
  }, [index]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((i) => (displayItems.length ? (i + 1) % displayItems.length : 0));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((i) =>
          displayItems.length ? (i - 1 + displayItems.length) % displayItems.length : 0,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const hit = displayItems[index];
        if (hit) onPick(hit.title);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [displayItems, index, onClose, onPick, open]);

  if (!open) return null;

  const hoverSelect = (i: number) => (e: ReactMouseEvent) => {
    const last = lastMousePos.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    setIndex(i);
  };

  const style =
    mode === "complete" && anchorLeft != null && anchorTop != null
      ? { left: anchorLeft, top: anchorTop }
      : undefined;

  return (
    <>
      <button type="button" className={styles.wikiBackdrop} aria-label="关闭双链菜单" onClick={onClose} />
      <div
        className={`${styles.wikiPicker} ${mode === "insert" ? styles.wikiPickerCenter : ""}`}
        style={style}
        role="dialog"
        aria-label="插入双链"
      >
        <div className={styles.wikiPickerHead}>
          <span className={styles.wikiPickerTitle}>
            {mode === "complete" ? "补全双链" : "插入双链"}
          </span>
          <span className={styles.wikiPickerHint}>↑↓ 选择 · Enter 确认 · Esc 关闭</span>
        </div>
        <input
          ref={inputRef}
          className={styles.wikiSearch}
          value={query}
          placeholder="搜索笔记标题或路径…"
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <div ref={listRef} className={styles.wikiList} role="listbox">
          {displayItems.map((item, i) => (
            <button
              key={`${item.path}-${item.title}-${i}`}
              type="button"
              data-index={i}
              className={`${styles.wikiItem} ${i === index ? styles.wikiItemActive : ""}`}
              onMouseMove={hoverSelect(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(item.title);
              }}
            >
              <span className={styles.wikiGlyph}>[[</span>
              <span className={styles.wikiItemText}>
                <span className={styles.wikiItemTitle}>{item.title}</span>
                <span className={styles.wikiItemPath}>
                  {item.path || (items.length ? "" : "库中暂无匹配，仍可写入")}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** 正文末尾未闭合的 [[query */
export function readTrailingWikilinkQuery(md: string): string | null {
  const match = /\[\[([^\]\n]*)$/.exec(md || "");
  if (!match) return null;
  return match[1] ?? "";
}

export function replaceTrailingWikilink(md: string, title: string): string {
  const name = title.trim() || "笔记名";
  return (md || "").replace(/\[\[([^\]\n]*)$/, `[[${name}]]`);
}
