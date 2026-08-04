import type { Editor } from "@tiptap/react";
import { getContributedSlashItems } from "@/shared/editor-extensions";
import { startWikilinkSuggest } from "./wikilink/WikilinkSuggest";

export type SlashCommandItem = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  run: (editor: Editor) => void;
};

export function deleteSlashQuery(editor: Editor) {
  const { state } = editor;
  const { from } = state.selection;
  const $from = state.doc.resolve(from);
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const match = /(?:^|\s)(\/[^\s]*)$/.exec(textBefore);
  if (!match) return;
  const deleteFrom = from - match[1].length;
  editor.chain().focus().deleteRange({ from: deleteFrom, to: from }).run();
}

const CORE_SLASH_COMMANDS: SlashCommandItem[] = [
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
];

function contributedSlashCommands(): SlashCommandItem[] {
  return getContributedSlashItems().map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    keywords: item.keywords,
    run: (editor) => {
      deleteSlashQuery(editor);
      if (item.action === "wikilink-suggest") {
        startWikilinkSuggest(editor);
        return;
      }
      if (item.insertMarkdown) {
        editor.chain().focus().insertContent(item.insertMarkdown).run();
      }
    },
  }));
}

/** 核心命令 + 编辑扩展贡献的 slash（同 id 时扩展覆盖） */
export function getSlashCommands(): SlashCommandItem[] {
  const map = new Map<string, SlashCommandItem>();
  for (const item of CORE_SLASH_COMMANDS) map.set(item.id, item);
  for (const item of contributedSlashCommands()) map.set(item.id, item);
  return Array.from(map.values());
}

/** @deprecated 使用 getSlashCommands()；保留兼容导出 */
export const SLASH_COMMANDS = getSlashCommands();

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const all = getSlashCommands();
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter(
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
