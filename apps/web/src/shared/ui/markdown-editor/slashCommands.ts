import type { Editor } from "@tiptap/react";

export type SlashCommandItem = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  run: (editor: Editor) => void;
};

function deleteSlashQuery(editor: Editor) {
  const { state } = editor;
  const { from } = state.selection;
  const $from = state.doc.resolve(from);
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const match = /(?:^|\s)(\/[^\s]*)$/.exec(textBefore);
  if (!match) return;
  const deleteFrom = from - match[1].length;
  editor.chain().focus().deleteRange({ from: deleteFrom, to: from }).run();
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "paragraph",
    title: "正文",
    description: "普通段落",
    keywords: ["p", "正文", "paragraph", "text"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().setParagraph().run();
    },
  },
  {
    id: "h1",
    title: "一级标题",
    description: "一级标题",
    keywords: ["h1", "title", "标题", "heading"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().toggleHeading({ level: 1 }).run();
    },
  },
  {
    id: "h2",
    title: "二级标题",
    description: "二级标题",
    keywords: ["h2", "标题", "heading"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().toggleHeading({ level: 2 }).run();
    },
  },
  {
    id: "h3",
    title: "三级标题",
    description: "三级标题",
    keywords: ["h3", "标题", "heading"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().toggleHeading({ level: 3 }).run();
    },
  },
  {
    id: "h4",
    title: "四级标题",
    description: "四级标题",
    keywords: ["h4", "标题", "heading"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().toggleHeading({ level: 4 }).run();
    },
  },
  {
    id: "bullet",
    title: "无序列表",
    description: "• 列表项",
    keywords: ["ul", "list", "无序", "列表", "bullet"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().toggleBulletList().run();
    },
  },
  {
    id: "ordered",
    title: "有序列表",
    description: "1. 列表项",
    keywords: ["ol", "有序", "列表", "numbered"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().toggleOrderedList().run();
    },
  },
  {
    id: "task",
    title: "任务列表",
    description: "可勾选待办",
    keywords: ["todo", "task", "任务", "checkbox"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().toggleTaskList().run();
    },
  },
  {
    id: "quote",
    title: "引用",
    description: "引用块",
    keywords: ["quote", "blockquote", "引用"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().toggleBlockquote().run();
    },
  },
  {
    id: "code",
    title: "代码块",
    description: "多行代码",
    keywords: ["code", "代码", "pre"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().toggleCodeBlock().run();
    },
  },
  {
    id: "hr",
    title: "分割线",
    description: "水平分隔",
    keywords: ["hr", "divider", "分割", "线"],
    run: (editor) => {
      deleteSlashQuery(editor);
      editor.chain().focus().setHorizontalRule().run();
    },
  },
  {
    id: "link",
    title: "链接",
    description: "插入超链接",
    keywords: ["link", "url", "链接"],
    run: (editor) => {
      deleteSlashQuery(editor);
      const prev = editor.getAttributes("link").href as string | undefined;
      const url = window.prompt("链接地址", prev || "https://");
      if (url === null) return;
      if (url === "") {
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
        return;
      }
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    },
  },
  {
    id: "wikilink",
    title: "双链笔记",
    description: "插入 [[笔记名]]，用于关系图谱",
    keywords: ["wiki", "wikilink", "双链", "笔记", "obsidian", "[[", "]]"],
    run: (editor) => {
      deleteSlashQuery(editor);
      const name = window.prompt("笔记名称（写入 [[笔记名]]）", "");
      if (name === null) return;
      const target = name.trim() || "笔记名";
      editor.chain().focus().insertContent(`[[${target}]]`).run();
    },
  },
];

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.keywords.some((k) => k.includes(q)),
  );
}

export function readSlashQuery(editor: Editor): { query: string; from: number } | null {
  const { from } = editor.state.selection;
  const $from = editor.state.doc.resolve(from);
  if (!$from.parent.isTextblock) return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const match = /(?:^|\s)\/([^\s]*)$/.exec(textBefore);
  if (!match) return null;
  return { query: match[1] || "", from: from - match[0].trimStart().length };
}
