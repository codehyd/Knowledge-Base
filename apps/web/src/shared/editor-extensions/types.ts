export type SlashGroup = "常用" | "结构" | "媒体" | "图示";

/** 声明式 slash 贡献项（第三方包只能插入固定 Markdown，不跑任意 JS） */
export type DeclarativeSlashItem = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  group?: SlashGroup;
  insertMarkdown?: string;
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

export type SlashRuntime = {
  sourceId?: number | null;
  uploadImage?: (file: File) => Promise<string | null>;
};
