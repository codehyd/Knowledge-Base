import type { EditorExtensionManifest } from "../types";

export const WIKILINK_EXTENSION: EditorExtensionManifest = {
  id: "wikilink",
  name: "双链笔记",
  version: "1.0.0",
  builtin: true,
  contributes: {
    marks: ["wikilink"],
    slash: [
      {
        id: "wikilink",
        title: "双链笔记",
        description: "搜索库内笔记并插入 [[名称]]",
        keywords: ["wiki", "wikilink", "双链", "笔记", "obsidian", "[[", "]]"],
        group: "常用",
        action: "wikilink-suggest",
      },
    ],
  },
};
