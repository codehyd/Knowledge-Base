import { useEffect, useMemo, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { filterSlashCommands, type SlashCommandItem } from "./slashCommands";
import styles from "./MarkdownEditor.module.css";

type Props = {
  editor: Editor;
  query: string;
  left: number;
  top: number;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onClose: () => void;
};

export function SlashCommandMenu({
  editor,
  query,
  left,
  top,
  selectedIndex,
  onSelectedIndexChange,
  onClose,
}: Props) {
  const items = useMemo(() => filterSlashCommands(query), [query]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedIndex >= items.length) {
      onSelectedIndexChange(0);
    }
  }, [items.length, onSelectedIndexChange, selectedIndex]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!items.length) {
    return (
      <div className={styles.slashMenu} style={{ left, top }} role="listbox">
        <div className={styles.slashEmpty}>无匹配命令</div>
      </div>
    );
  }

  const run = (item: SlashCommandItem) => {
    item.run(editor);
    onClose();
  };

  return (
    <div
      ref={listRef}
      className={styles.slashMenu}
      style={{ left, top }}
      role="listbox"
      aria-label="插入命令"
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          data-index={index}
          className={`${styles.slashItem} ${index === selectedIndex ? styles.slashItemActive : ""}`}
          onMouseEnter={() => onSelectedIndexChange(index)}
          onMouseDown={(e) => {
            e.preventDefault();
            run(item);
          }}
        >
          <span className={styles.slashTitle}>{item.title}</span>
          <span className={styles.slashDesc}>{item.description}</span>
        </button>
      ))}
    </div>
  );
}

export function getFilteredSlashItems(query: string) {
  return filterSlashCommands(query);
}
