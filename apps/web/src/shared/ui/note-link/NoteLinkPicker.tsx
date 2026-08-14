import { useEffect, useRef, useState } from "react";
import { api, type VaultLinkTarget } from "@/shared/api/client";
import {
  extractMarkdownHeadings,
  type MarkdownHeading,
} from "@/shared/ui/markdown-editor/wikilink/parse";
import styles from "@/shared/ui/markdown-editor/MarkdownEditor.module.css";

/** 双链唤起快捷键：Ctrl/Cmd + Shift + L（Link） */
export const NOTE_LINK_HOTKEY = {
  key: "l",
  shift: true,
  /** mod = Ctrl on Win/Linux, Meta on macOS */
  mod: true,
} as const;

export function isNoteLinkHotkey(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  if (key !== NOTE_LINK_HOTKEY.key) return false;
  if (!event.shiftKey) return false;
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return false;
  if (event.altKey) return false;
  return true;
}

export function noteLinkHotkeyLabel(isMac = false): string {
  return isMac ? "⌘⇧L" : "Ctrl+Shift+L";
}

export type NoteLinkPickResult = {
  /** 写入 [[…]] 的内容（可含 #标题） */
  label: string;
  item: VaultLinkTarget | null;
  heading?: string | null;
};

type ListRow =
  | { kind: "note"; item: VaultLinkTarget }
  | { kind: "heading"; item: VaultLinkTarget; heading: MarkdownHeading; label: string };

type Props = {
  open: boolean;
  left?: number;
  top?: number;
  initialQuery?: string;
  /** 排除「链到整篇自己」；仍允许 当前笔记#标题 */
  excludeSourceId?: number | null;
  onClose: () => void;
  onPick: (label: string, item: VaultLinkTarget | null) => void;
};

function noteLabel(item: VaultLinkTarget) {
  return item.title?.trim() || item.stem || item.path.replace(/\.md$/i, "");
}

export function NoteLinkPicker({
  open,
  left,
  top,
  initialQuery = "",
  excludeSourceId = null,
  onClose,
  onPick,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [rows, setRows] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setIndex(0);
  }, [open, initialQuery]);

  // 点击弹层外（含编辑区空白）→ 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (!node) return;
      if (menuRef.current?.contains(node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const hash = query.indexOf("#");
          const noteQuery = (hash >= 0 ? query.slice(0, hash) : query).trim();
          const headingQuery = hash >= 0 ? query.slice(hash + 1).trim() : "";
          const wantHeadings = hash >= 0;

          const res = await api.getVaultLinkTargets({ q: noteQuery, limit: 20 });
          if (cancelled) return;

          let notes = res.items;
          // 整篇列表去掉当前笔记；标题模式仍可链到本篇标题
          if (!wantHeadings && excludeSourceId != null) {
            notes = notes.filter((it) => it.source_id !== excludeSourceId);
          }

          if (!wantHeadings) {
            setRows(notes.map((item) => ({ kind: "note", item })));
            setTotal(res.total);
            setIndex(0);
            return;
          }

          // 标题模式：锁定一篇笔记，列出其 Markdown 标题
          const qLower = noteQuery.toLowerCase();
          const note =
            notes.find((it) => {
              const pathNorm = it.path.replace(/\.md$/i, "").toLowerCase();
              const title = (it.title || "").toLowerCase();
              const stem = (it.stem || "").toLowerCase();
              return (
                title === qLower ||
                stem === qLower ||
                pathNorm === qLower ||
                pathNorm.endsWith(`/${qLower}`) ||
                title.includes(qLower) ||
                stem.includes(qLower)
              );
            }) || notes[0];

          if (!note?.source_id) {
            setRows([]);
            setTotal(0);
            setIndex(0);
            return;
          }

          const detail = await api.getVaultNote(note.source_id);
          if (cancelled) return;
          const headings = extractMarkdownHeadings(detail.content || "");
          const hq = headingQuery.toLowerCase();
          const filtered = hq
            ? headings.filter((h) => h.text.toLowerCase().includes(hq))
            : headings;

          const base = noteLabel(note);
          const headingRows: ListRow[] = filtered.map((heading) => ({
            kind: "heading",
            item: note,
            heading,
            label: `${base}#${heading.text}`,
          }));

          // 仍提供「整篇」选项（若不是当前笔记）
          const rowsOut: ListRow[] = [];
          if (note.source_id !== excludeSourceId) {
            rowsOut.push({ kind: "note", item: note });
          }
          rowsOut.push(...headingRows);
          setRows(rowsOut);
          setTotal(rowsOut.length);
          setIndex(0);
        } catch {
          if (!cancelled) {
            setRows([]);
            setTotal(0);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, query, excludeSourceId]);

  const pickRow = (row: ListRow) => {
    if (row.kind === "heading") {
      onPick(row.label, row.item);
      return;
    }
    onPick(noteLabel(row.item), row.item);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" && rows.length) {
        event.preventDefault();
        event.stopPropagation();
        setIndex((i) => (i + 1) % rows.length);
        return;
      }
      if (event.key === "ArrowUp" && rows.length) {
        event.preventDefault();
        event.stopPropagation();
        setIndex((i) => (i - 1 + rows.length) % rows.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (rows.length) {
          pickRow(rows[index]);
        } else if (query.trim()) {
          // 允许手写 [[笔记#标题]]
          onPick(query.trim(), null);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows, index, query, onClose, onPick]);

  if (!open) return null;

  const style: React.CSSProperties =
    left != null && top != null
      ? { left, top }
      : { left: "50%", top: "20%", transform: "translateX(-50%)" };

  const headingMode = query.includes("#");

  return (
    <div
      ref={menuRef}
      className={styles.wikilinkMenu}
      style={style}
      role="listbox"
      aria-label="链接到笔记或标题"
    >
      <div className={styles.wikilinkMenuHead}>
        {headingMode
          ? "链接到标题（笔记#标题）"
          : `链接到笔记${!query.trim() && total > 0 ? ` · ${Math.min(rows.length, total)} 篇` : ""}`}
      </div>
      <input
        className={styles.wikilinkSearch}
        autoFocus
        value={query}
        placeholder={headingMode ? "笔记名#标题关键字…" : "搜索笔记；输入 # 可选标题…"}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) {
            e.stopPropagation();
          }
        }}
      />
      {loading ? <div className={styles.wikilinkEmpty}>搜索中…</div> : null}
      {!loading && rows.length === 0 ? (
        <div className={styles.wikilinkEmpty}>
          {query.trim()
            ? headingMode
              ? `无匹配标题；Enter 仍可插入 [[${query.trim()}]]`
              : `无匹配「${query.trim()}」；Enter 仍可插入 [[${query.trim()}]]`
            : "暂无笔记，请先新建并保存后再链接"}
        </div>
      ) : null}
      {rows.map((row, i) => (
        <button
          key={row.kind === "heading" ? `${row.item.id}#${row.heading.text}` : row.item.id}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`${styles.wikilinkItem} ${i === index ? styles.wikilinkItemActive : ""}`}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            pickRow(row);
          }}
        >
          {row.kind === "heading" ? (
            <>
              <span className={styles.wikilinkTitle}>
                {"#".repeat(row.heading.level)} {row.heading.text}
              </span>
              <span className={styles.wikilinkPath}>{noteLabel(row.item)}</span>
            </>
          ) : (
            <>
              <span className={styles.wikilinkTitle}>{row.item.title}</span>
              <span className={styles.wikilinkPath}>
                {headingMode ? "整篇笔记" : row.item.path}
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
