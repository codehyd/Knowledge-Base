import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import { Markdown } from "tiptap-markdown";
import {
  BoldOutlined,
  CheckSquareOutlined,
  CodeOutlined,
  DownOutlined,
  FontSizeOutlined,
  ItalicOutlined,
  LinkOutlined,
  MinusOutlined,
  OrderedListOutlined,
  RedoOutlined,
  StrikethroughOutlined,
  UnderlineOutlined,
  UndoOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { App, Button, Dropdown, Tooltip } from "antd";
import { hasMark } from "@/shared/editor-extensions";
import { getFilteredSlashItems, SlashCommandMenu } from "./SlashCommandMenu";
import { readSlashQuery } from "./slashCommands";
import { restoreWikilinkMarkers } from "./wikilinks";
import { WikilinkExtension, type WikilinkSuggestState } from "./wikilink/WikilinkExtension";
import { WikilinkSuggest } from "./wikilink/WikilinkSuggest";
import { resolveWikilinkHref } from "./wikilink/resolve";
import { headingMatches } from "./wikilink/parse";
import { openInSystemBrowser } from "@/shared/ui/lake-editor/openExternalLink";
import styles from "./MarkdownEditor.module.css";

export type MarkdownEditorHandle = {
  getMarkdown: () => string;
  focus: () => void;
  setMarkdown: (md: string) => void;
  /** 在光标处插入双链字面量 [[label]] */
  insertWikilink: (label: string) => void;
  /** 滚到正文中匹配的标题（支持 # 锚点） */
  scrollToHeading: (heading: string) => boolean;
};

type Props = {
  initialMarkdown?: string;
  placeholder?: string;
  dirty?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSave?: () => void | Promise<void>;
  saving?: boolean;
  /** 当前笔记 id：补全时排除「链到整篇自己」 */
  excludeSourceId?: number | null;
  /** 打开时滚到该标题（来自 URL ?heading=） */
  initialHeading?: string | null;
};

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

const QuoteIcon = () => (
  <svg width="1em" height="1em" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <path d="M3.2 4.5c-1.4.7-2.2 2-2.2 3.7V12h4.2V7.8H3.4c0-1 .5-1.9 1.6-2.4L3.2 4.5zm6.6 0c-1.4.7-2.2 2-2.2 3.7V12h4.2V7.8H10c0-1 .5-1.9 1.6-2.4L9.8 4.5z" />
  </svg>
);

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  {
    initialMarkdown = "",
    placeholder = "输入正文，或按 / 插入块；[[ 笔记 或 笔记#标题…",
    dirty = false,
    onDirtyChange,
    onSave,
    saving = false,
    excludeSourceId = null,
    initialHeading = null,
  },
  ref,
) {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [slash, setSlash] = useState<{
    query: string;
    left: number;
    top: number;
  } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [wikiSuggest, setWikiSuggest] = useState<WikilinkSuggestState | null>(null);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  /** Esc 关闭后，在未闭合 [[ 仍存在时禁止立刻再次弹出 */
  const wikiDismissedRef = useRef(false);
  const mod = useMemo(() => (isMac() ? "⌘" : "Ctrl"), []);
  const onSaveRef = useCallback(() => onSave?.(), [onSave]);
  const enableWikilink = hasMark("wikilink");
  /** 供 Esc 关闭后回焦；避免在 useEditor 之前引用 editor 造成 TDZ 白屏 */
  const editorFocusRef = useRef<{ commands: { focus: (pos?: string) => boolean } } | null>(null);

  const dismissWikiSuggest = useCallback(() => {
    wikiDismissedRef.current = true;
    setWikiSuggest(null);
    window.requestAnimationFrame(() => {
      try {
        editorFocusRef.current?.commands.focus();
      } catch {
        /* 切换笔记时 editor 可能已销毁 */
      }
    });
  }, []);

  const openLinkRef = useRef<(target: string) => void>(() => {});
  openLinkRef.current = (target: string) => {
    void (async () => {
      try {
        const href = await resolveWikilinkHref(target);
        if (!href) {
          message.warning(`断链：未找到「${target}」`);
          return;
        }
        navigate(href);
      } catch {
        message.error("打开双链失败");
      }
    })();
  };

  const handleWikiSuggest = useCallback((state: WikilinkSuggestState | null) => {
    if (!state?.active) {
      wikiDismissedRef.current = false;
      setWikiSuggest((prev) => (prev ? null : prev));
      return;
    }
    if (wikiDismissedRef.current) return;
    setWikiSuggest(state);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        link: false,
      }),
      Underline,
      Typography,
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
      }),
      Placeholder.configure({ placeholder }),
      Markdown.configure({
        html: false,
        tightLists: true,
        bulletListMarker: "-",
        linkify: false,
        breaks: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      ...(enableWikilink
        ? [
            WikilinkExtension.configure({
              onSuggest: handleWikiSuggest,
              onOpenLink: (target) => openLinkRef.current(target),
            }),
          ]
        : []),
    ],
    content: initialMarkdown || "",
    editorProps: {
      attributes: {
        class: "tiptap",
        spellcheck: "false",
      },
      handleClick: (_view, _pos, event) => {
        if (event.button !== 0) return false;
        const el = event.target as HTMLElement | null;
        if (!el) return false;
        // 双链芯片走 WikilinkExtension，不在这里处理
        if (el.closest?.(".kk-wikilink, [data-wikilink-target], .wikilink")) return false;
        const anchor = el.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!anchor?.href) return false;
        const href = anchor.getAttribute("href") || anchor.href;
        if (!href || href.startsWith("#")) return false;
        event.preventDefault();
        openInSystemBrowser(href);
        return true;
      },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void onSaveRef();
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.altKey && ["1", "2", "3"].includes(event.key)) {
          event.preventDefault();
          return false;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      onDirtyChange?.(true);
      const hit = readSlashQuery(ed);
      if (!hit) {
        setSlash(null);
        return;
      }
      // 双链建议打开时不抢 slash 菜单
      if (enableWikilink) {
        const $from = ed.state.doc.resolve(ed.state.selection.from);
        const textBefore = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
        if (/\[\[[^\]]*$/.test(textBefore)) {
          setSlash(null);
          return;
        }
      }
      const coords = ed.view.coordsAtPos(ed.state.selection.from);
      setSlash({
        query: hit.query,
        left: Math.min(coords.left, window.innerWidth - 300),
        top: Math.min(coords.bottom + 6, window.innerHeight - 300),
      });
      setSlashIndex(0);
    },
  });

  editorFocusRef.current = editor;

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => {
        if (!editor) return "";
        const raw = (editor.storage as { markdown?: { getMarkdown: () => string } }).markdown
          ?.getMarkdown?.();
        return restoreWikilinkMarkers(raw || "");
      },
      focus: () => {
        editor?.commands.focus("end");
      },
      setMarkdown: (md: string) => {
        editor?.commands.setContent(md || "");
      },
      insertWikilink: (label: string) => {
        const text = `[[${(label || "笔记名").trim()}]]`;
        editor?.chain().focus("end").insertContent(text).run();
      },
      scrollToHeading: (heading: string) => {
        if (!editor || !heading.trim()) return false;
        try {
          let foundPos: number | null = null;
          editor.state.doc.descendants((node, pos) => {
            if (foundPos != null) return false;
            if (node.type.name === "heading" && headingMatches(heading, node.textContent || "")) {
              foundPos = pos;
              return false;
            }
            return true;
          });
          if (foundPos == null) return false;
          const max = editor.state.doc.content.size;
          const sel = Math.min(foundPos + 1, Math.max(1, max));
          editor.chain().focus().setTextSelection(sel).run();
          const dom = editor.view.nodeDOM(foundPos);
          if (dom instanceof HTMLElement) {
            dom.scrollIntoView({ block: "start", behavior: "smooth" });
          }
          return true;
        } catch (err) {
          console.warn("[markdown-editor] scrollToHeading", err);
          return false;
        }
      },
    }),
    [editor],
  );

  useEffect(() => {
    if (!editor) return;
    try {
      editor.commands.setContent(initialMarkdown || "", { emitUpdate: false });
    } catch (err) {
      console.warn("[markdown-editor] setContent", err);
      try {
        editor.commands.setContent("", { emitUpdate: false });
      } catch {
        /* ignore */
      }
    }
    const timer = window.setTimeout(() => {
      try {
        if (initialHeading?.trim()) {
          let foundPos: number | null = null;
          editor.state.doc.descendants((node, pos) => {
            if (foundPos != null) return false;
            if (
              node.type.name === "heading" &&
              headingMatches(initialHeading, node.textContent || "")
            ) {
              foundPos = pos;
              return false;
            }
            return true;
          });
          if (foundPos != null) {
            const max = editor.state.doc.content.size;
            const sel = Math.min(foundPos + 1, Math.max(1, max));
            editor.chain().focus().setTextSelection(sel).run();
            const dom = editor.view.nodeDOM(foundPos);
            if (dom instanceof HTMLElement) {
              dom.scrollIntoView({ block: "start", behavior: "smooth" });
            }
            return;
          }
        }
        editor.commands.focus("end");
      } catch (err) {
        console.warn("[markdown-editor] autofocus", err);
      }
    }, 40);
    return () => window.clearTimeout(timer);
  }, [editor, initialMarkdown, initialHeading]);

  const closeSlash = useCallback(() => setSlash(null), []);

  // 点击双链/slash 菜单外（编辑区空白等）→ 关闭菜单，焦点留在编辑器
  useEffect(() => {
    if (!wikiSuggest?.active && !slash) return;
    const onPointerDown = (event: PointerEvent) => {
      const el = event.target as HTMLElement | null;
      if (!el) return;
      if (el.closest(`.${styles.wikilinkMenu}`) || el.closest(`.${styles.slashMenu}`)) return;
      if (wikiSuggest?.active) dismissWikiSuggest();
      if (slash) closeSlash();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [wikiSuggest, slash, dismissWikiSuggest, closeSlash]);

  useEffect(() => {
    if (!editor) return;
    const onKey = (event: KeyboardEvent) => {
      const modKey = event.ctrlKey || event.metaKey;
      if (modKey && event.altKey && ["1", "2", "3", "4"].includes(event.key)) {
        event.preventDefault();
        const level = Number(event.key) as 1 | 2 | 3 | 4;
        editor.chain().focus().toggleHeading({ level }).run();
        return;
      }
      if (modKey && event.altKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        editor.chain().focus().toggleCodeBlock().run();
        return;
      }
      // 行内代码：Ctrl/Cmd + `
      if (modKey && (event.key === "`" || event.code === "Backquote")) {
        event.preventDefault();
        editor.chain().focus().toggleCode().run();
        return;
      }
      if (modKey && event.shiftKey && event.key.toLowerCase() === "x") {
        event.preventDefault();
        editor.chain().focus().toggleStrike().run();
        return;
      }
      if (modKey && event.key.toLowerCase() === "u") {
        event.preventDefault();
        editor.chain().focus().toggleUnderline().run();
        return;
      }
      if (modKey && event.shiftKey && event.key === "8") {
        event.preventDefault();
        editor.chain().focus().toggleBulletList().run();
        return;
      }
      if (modKey && event.shiftKey && event.key === "7") {
        event.preventDefault();
        editor.chain().focus().toggleOrderedList().run();
        return;
      }
      if (modKey && event.shiftKey && event.key === "9") {
        event.preventDefault();
        editor.chain().focus().toggleTaskList().run();
        return;
      }
      if (modKey && event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        editor.chain().focus().toggleBlockquote().run();
        return;
      }
      if (modKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const prev = editor.getAttributes("link").href as string | undefined;
        const url = window.prompt("链接地址", prev || "https://");
        if (url === null) return;
        if (!url) {
          editor.chain().focus().extendMarkRange("link").unsetLink().run();
          return;
        }
        editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
        return;
      }
      if (event.key === "Escape" && wikiSuggest?.active) {
        event.preventDefault();
        event.stopPropagation();
        dismissWikiSuggest();
        return;
      }
      if (event.key === "Escape" && slash) {
        event.preventDefault();
        event.stopPropagation();
        closeSlash();
        editor.commands.focus();
        return;
      }
      if (wikiSuggest?.active) return;
      if (!slash) return;
      const items = getFilteredSlashItems(slash.query);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((i) => (items.length ? (i + 1) % items.length : 0));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
        return;
      }
      if (event.key === "Enter" && items.length) {
        event.preventDefault();
        event.stopPropagation();
        items[slashIndex]?.run(editor);
        closeSlash();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeSlash, dismissWikiSuggest, editor, slash, slashIndex, wikiSuggest]);

  if (!editor) return null;

  const promptLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("链接地址", prev || "https://");
    if (url === null) return;
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const btn = (
    tip: string,
    active: boolean,
    onClick: () => void,
    icon: ReactNode,
    label?: string,
    disabled?: boolean,
  ) => (
    <Tooltip title={tip}>
      <Button
        type="text"
        size="small"
        className={`${styles.toolbarBtn} ${active ? styles.toolbarBtnActive : ""}`}
        icon={icon}
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </Button>
    </Tooltip>
  );

  const headingLevel = ([1, 2, 3, 4] as const).find((l) => editor.isActive("heading", { level: l }));

  const styleSelect = (
    <Dropdown
      menu={{
        items: [
          { key: "p", label: "正文" },
          ...([1, 2, 3, 4] as const).map((l) => ({ key: `h${l}`, label: `标题 ${l}` })),
        ],
        selectedKeys: [headingLevel ? `h${headingLevel}` : "p"],
        onClick: ({ key, domEvent }) => {
          domEvent.preventDefault();
          if (key === "p") {
            editor.chain().focus().setParagraph().run();
          } else {
            editor.chain().focus().toggleHeading({ level: Number(key.slice(1)) as 1 | 2 | 3 | 4 }).run();
          }
        },
      }}
      trigger={["click"]}
    >
      <Button type="text" size="small" className={styles.styleSelect}>
        {headingLevel ? `标题 ${headingLevel}` : "正文"}
        <DownOutlined className={styles.styleSelectArrow} />
      </Button>
    </Dropdown>
  );

  return (
    <div className={styles.root}>
      <Tooltip title={toolbarOpen ? "收起格式工具栏" : "格式工具栏"}>
        <Button
          type="text"
          size="small"
          className={`${styles.toolbarToggle}${toolbarOpen ? ` ${styles.toolbarToggleActive}` : ""}`}
          icon={<FontSizeOutlined />}
          onClick={() => setToolbarOpen((v) => !v)}
        />
      </Tooltip>
      <div className={`${styles.toolbarDock}${toolbarOpen ? ` ${styles.toolbarDockOpen}` : ""}`}>
        {btn("撤销", false, () => editor.chain().focus().undo().run(), <UndoOutlined />, undefined, !editor.can().undo())}
        {btn("重做", false, () => editor.chain().focus().redo().run(), <RedoOutlined />, undefined, !editor.can().redo())}
        <span className={styles.sep} />
        {styleSelect}
        <span className={styles.sep} />
        {btn(`${mod}+B 加粗`, editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), <BoldOutlined />)}
        {btn(`${mod}+I 斜体`, editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), <ItalicOutlined />)}
        {btn("下划线", editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), <UnderlineOutlined />)}
        {btn("删除线", editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), <StrikethroughOutlined />)}
        <span className={styles.sep} />
        {btn("无序列表", editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), <UnorderedListOutlined />)}
        {btn("有序列表", editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), <OrderedListOutlined />)}
        {btn("任务列表", editor.isActive("taskList"), () => editor.chain().focus().toggleTaskList().run(), <CheckSquareOutlined />)}
        <span className={styles.sep} />
        {btn("引用", editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run(), <QuoteIcon />)}
        {btn("代码块", editor.isActive("codeBlock"), () => editor.chain().focus().toggleCodeBlock().run(), <CodeOutlined />)}
        {btn(`${mod}+K 链接`, editor.isActive("link"), promptLink, <LinkOutlined />)}
        {btn("分割线", false, () => editor.chain().focus().setHorizontalRule().run(), <MinusOutlined />)}
      </div>

      <BubbleMenu
        editor={editor}
        options={{ placement: "top", offset: 8, flip: true }}
        shouldShow={({ editor: e, state }) =>
          e.isEditable && !state.selection.empty && !e.isActive("codeBlock")
        }
      >
        <div className={styles.bubble}>
          {btn(`${mod}+B 加粗`, editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), <BoldOutlined />)}
          {btn(`${mod}+I 斜体`, editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), <ItalicOutlined />)}
          {btn("下划线", editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), <UnderlineOutlined />)}
          {btn("删除线", editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), <StrikethroughOutlined />)}
          {btn(`${mod}+\` 行内代码`, editor.isActive("code"), () => editor.chain().focus().toggleCode().run(), <CodeOutlined />)}
          {btn(`${mod}+K 链接`, editor.isActive("link"), promptLink, <LinkOutlined />)}
          <span className={styles.sep} />
          {btn(`${mod}+Alt+1`, editor.isActive("heading", { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), null, "H1")}
          {btn(`${mod}+Alt+2`, editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), null, "H2")}
          {btn(`${mod}+Alt+3`, editor.isActive("heading", { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), null, "H3")}
          {btn("引用", editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run(), <QuoteIcon />)}
        </div>
      </BubbleMenu>

      <div className={styles.editorWrap}>
        <div className={styles.editor}>
          <EditorContent editor={editor} />
        </div>
        {slash && !wikiSuggest ? (
          <SlashCommandMenu
            editor={editor}
            query={slash.query}
            left={slash.left}
            top={slash.top}
            selectedIndex={slashIndex}
            onSelectedIndexChange={setSlashIndex}
            onClose={closeSlash}
          />
        ) : null}
        {wikiSuggest?.active ? (
          <WikilinkSuggest
            editor={editor}
            state={wikiSuggest}
            excludeSourceId={excludeSourceId}
            onClose={dismissWikiSuggest}
          />
        ) : null}
      </div>

      <div className={styles.footer}>
        <span className={dirty ? styles.saveStateDirty : undefined}>
          {dirty ? (saving ? "保存中…" : "未保存") : "已保存"}
        </span>
        <span className={styles.footerHint}>{mod}+S 保存 · `/` 插入 · `[[` 笔记 或 笔记#标题</span>
      </div>
    </div>
  );
});
