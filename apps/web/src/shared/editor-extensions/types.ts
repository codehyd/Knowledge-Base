import type { Editor } from "@tiptap/react";

/** 声明式 slash 贡献项（第三方包只能插入固定 Markdown，不跑任意 JS） */
export type DeclarativeSlashItem = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  /** 选中后插入的 Markdown 片段；双链等内置项可改用 openSuggest */
  insertMarkdown?: string;
  /** 内置：打开双链搜索面板 */
  action?: "wikilink-suggest";
};

export type EditorExtensionManifest = {
  id: string;
  name: string;
  version: string;
  builtin?: boolean;
  contributes: {
    slash?: DeclarativeSlashItem[];
    marks?: Array<"wikilink">;
  };
};

export type SlashRunner = (editor: Editor) => void;
