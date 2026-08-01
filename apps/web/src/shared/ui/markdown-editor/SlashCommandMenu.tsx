import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import {
  CheckSquareOutlined,
  CodeOutlined,
  LinkOutlined,
  MinusOutlined,
  OrderedListOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { filterSlashCommands, type SlashCommandItem } from "./slashCommands";
import styles from "./MarkdownEditor.module.css";

const ITEM_ICONS: Record<string, ReactNode> = {
  h1: <span className={styles.slashGlyph}>H1</span>,
  h2: <span className={styles.slashGlyph}>H2</span>,
  h3: <span className={styles.slashGlyph}>H3</span>,
  h4: <span className={styles.slashGlyph}>H4</span>,
  paragraph: <span className={styles.slashGlyph}>Aa</span>,
  bullet: <UnorderedListOutlined />,
  ordered: <OrderedListOutlined />,
  task: <CheckSquareOutlined />,
  quote: <span className={styles.slashGlyph}>❝</span>,
  code: <CodeOutlined />,
  hr: <MinusOutlined />,
  link: <LinkOutlined />,
};

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
    const menu = listRef.current;
    const el = menu?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    if (!menu || !el) return;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    if (elTop < menu.scrollTop) {
      menu.scrollTop = elTop;
    } else if (elBottom > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = elBottom - menu.clientHeight;
    }
  }, [selectedIndex]);

  // 键盘滚动菜单时，浏览器会对静止的鼠标补发 mousemove，坐标没变则忽略，
  // 否则鼠标压住哪一项，选中项就被抢回哪一项
  const lastMousePos = useRef<{ x: number; y: number } | null>(null);

  const hoverSelect = (index: number) => (e: ReactMouseEvent) => {
    const last = lastMousePos.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    onSelectedIndexChange(index);
  };

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
      <div className={styles.slashGroup}>常用</div>
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          data-index={index}
          className={`${styles.slashItem} ${index === selectedIndex ? styles.slashItemActive : ""}`}
          onMouseMove={hoverSelect(index)}
          onMouseDown={(e) => {
            e.preventDefault();
            run(item);
          }}
        >
          <span className={styles.slashIcon}>{ITEM_ICONS[item.id]}</span>
          <span className={styles.slashTitle}>{item.title}</span>
        </button>
      ))}
    </div>
  );
}

export function getFilteredSlashItems(query: string) {
  return filterSlashCommands(query);
}
