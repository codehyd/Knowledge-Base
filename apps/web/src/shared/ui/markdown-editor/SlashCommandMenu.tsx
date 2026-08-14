import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  CheckSquareOutlined,
  CodeOutlined,
  ColumnWidthOutlined,
  FunctionOutlined,
  LinkOutlined,
  MinusOutlined,
  OrderedListOutlined,
  PictureOutlined,
  TableOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import {
  groupSlashItems,
  listSlashCommands,
  type SlashCommandItem,
} from "./slashCommands";
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
  wikilink: <span className={styles.slashGlyph}>[[</span>,
  table: <TableOutlined />,
  image: <PictureOutlined />,
  callout: <span className={styles.slashGlyph}>!</span>,
  fold: <span className={styles.slashGlyph}>▾</span>,
  columns: <ColumnWidthOutlined />,
  math: <FunctionOutlined />,
  "mermaid-flow": <span className={styles.slashGlyph}>▷</span>,
  "mermaid-seq": <span className={styles.slashGlyph}>⇄</span>,
  "mermaid-mind": <span className={styles.slashGlyph}>◎</span>,
};

const MENU_WIDTH = 318;
const MENU_MAX = 440;
const PAD = 12;
const GAP = 8;

function placeMenu(anchorLeft: number, caretTop: number, caretBottom: number, width: number, height: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spaceBelow = vh - PAD - caretBottom;
  const spaceAbove = caretTop - PAD;
  const need = Math.min(Math.max(height, 200), MENU_MAX);
  const placeAbove = spaceBelow < need && spaceAbove > spaceBelow;
  const maxHeight = Math.max(180, Math.min(need, placeAbove ? spaceAbove - GAP : spaceBelow - GAP));
  let x = anchorLeft;
  if (x + width > vw - PAD) x = vw - PAD - width;
  if (x < PAD) x = PAD;
  let y = placeAbove ? caretTop - GAP - maxHeight : caretBottom + GAP;
  if (y < PAD) y = PAD;
  if (y + maxHeight > vh - PAD) y = Math.max(PAD, vh - PAD - maxHeight);
  const arrowLeft = Math.max(16, Math.min(anchorLeft - x + 6, width - 28));
  return { left: x, top: y, maxHeight, placeAbove, arrowLeft };
}

type Props = {
  query: string;
  left: number;
  caretTop: number;
  caretBottom: number;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onRun: (item: SlashCommandItem) => void;
  onClose: () => void;
};

export function SlashCommandMenu({
  query,
  left,
  caretTop,
  caretBottom,
  selectedIndex,
  onSelectedIndexChange,
  onRun,
  onClose,
}: Props) {
  const items = useMemo(() => listSlashCommands(query), [query]);
  const groups = useMemo(() => groupSlashItems(items), [items]);
  const listRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(() =>
    placeMenu(left, caretTop, caretBottom, MENU_WIDTH, MENU_MAX),
  );

  useLayoutEffect(() => {
    if (selectedIndex >= items.length) onSelectedIndexChange(0);
  }, [items.length, onSelectedIndexChange, selectedIndex]);

  useLayoutEffect(() => {
    const el = listRef.current;
    const height = el ? Math.min(el.scrollHeight, MENU_MAX) : MENU_MAX;
    setBox(placeMenu(left, caretTop, caretBottom, MENU_WIDTH, height));
  }, [left, caretTop, caretBottom, items.length, selectedIndex]);

  useLayoutEffect(() => {
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

  const lastMousePos = useRef<{ x: number; y: number } | null>(null);

  const hoverSelect = (index: number) => (e: ReactMouseEvent) => {
    const last = lastMousePos.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    onSelectedIndexChange(index);
  };

  const run = (item: SlashCommandItem) => {
    onRun(item);
    onClose();
  };

  let offset = 0;
  const menu = (
    <div
      className={styles.slashMenu}
      data-placement={box.placeAbove ? "top" : "bottom"}
      style={{ left: box.left, top: box.top, width: MENU_WIDTH }}
      role="listbox"
      aria-label="插入命令"
    >
      <span className={styles.slashArrow} style={{ left: box.arrowLeft }} aria-hidden />
      <div ref={listRef} className={styles.slashMenuBody} style={{ maxHeight: box.maxHeight }}>
        {!items.length ? (
          <div className={styles.slashEmpty}>无匹配命令</div>
        ) : (
          groups.map(([group, list]) => {
            const start = offset;
            offset += list.length;
            return (
              <div key={group}>
                <div className={styles.slashGroup}>{group}</div>
                {list.map((item, i) => {
                  const index = start + i;
                  return (
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
                      <span className={styles.slashIcon}>{ITEM_ICONS[item.id] ?? <span className={styles.slashGlyph}>/</span>}</span>
                      <span className={styles.slashTitleCol}>
                        <span className={styles.slashTitle}>{item.title}</span>
                        {item.description ? <span className={styles.slashDesc}>{item.description}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}

export function getFilteredSlashItems(query: string) {
  return listSlashCommands(query);
}
