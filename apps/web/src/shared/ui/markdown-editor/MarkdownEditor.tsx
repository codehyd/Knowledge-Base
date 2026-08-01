import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
import { Button, Dropdown, Tooltip } from "antd";
import { getFilteredSlashItems, SlashCommandMenu } from "./SlashCommandMenu";
import { readSlashQuery } from "./slashCommands";
import styles from "./MarkdownEditor.module.css";

export type MarkdownEditorHandle = {
  getMarkdown: () => string;
  focus: () => void;
  setMarkdown: (md: string) => void;
};

type Props = {
  initialMarkdown?: string;
  placeholder?: string;
  dirty?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSave?: () => void | Promise<void>;
  saving?: boolean;
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
    placeholder = "输入正文，或按 / 插入块…",
    dirty = false,
    onDirtyChange,
    onSave,
    saving = false,
  },
  ref,
) {
  const [slash, setSlash] = useState<{
    query: string;
    left: number;
    top: number;
  } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const mod = useMemo(() => (isMac() ? "⌘" : "Ctrl"), []);
  const onSaveRef = useCallback(() => onSave?.(), [onSave]);

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
    ],
    content: initialMarkdown || "",
    editorProps: {
      attributes: {
        class: "tiptap",
        spellcheck: "false",
      },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void onSaveRef();
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.altKey && ["1", "2", "3"].includes(event.key)) {
          event.preventDefault();
          const level = Number(event.key) as 1 | 2 | 3;
          // handled below via editor — need editor in closure; use chain after mount
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
      const coords = ed.view.coordsAtPos(ed.state.selection.from);
      setSlash({
        query: hit.query,
        left: Math.min(coords.left, window.innerWidth - 300),
        top: Math.min(coords.bottom + 6, window.innerHeight - 300),
      });
      setSlashIndex(0);
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => {
        if (!editor) return "";
        return (editor.storage.markdown.getMarkdown() as string) || "";
      },
      focus: () => {
        editor?.commands.focus();
      },
      setMarkdown: (md: string) => {
        editor?.commands.setContent(md || "");
      },
    }),
    [editor],
  );

  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(initialMarkdown || "", { emitUpdate: false });
  }, [editor, initialMarkdown]);

  const closeSlash = useCallback(() => setSlash(null), []);

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
      if (event.key === "Escape" && slash) {
        event.preventDefault();
        closeSlash();
        return;
      }
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
  }, [closeSlash, editor, slash, slashIndex]);

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
        {slash ? (
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
      </div>

      <div className={styles.footer}>
        <span className={dirty ? styles.saveStateDirty : undefined}>
          {dirty ? (saving ? "保存中…" : "未保存") : "已保存"}
        </span>
        <span className={styles.footerHint}>{mod}+S 保存 · `/` 插入块</span>
      </div>
    </div>
  );
});
