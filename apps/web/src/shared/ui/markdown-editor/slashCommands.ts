import { getContributedSlashItems } from "@/shared/editor-extensions";
import type { SlashGroup, SlashRuntime } from "@/shared/editor-extensions";

export type MarkdownHost = {
  replaceSlash(text: string): void;
  insert(text: string): void;
  wrap(before: string, after?: string): void;
  startWikilink(): void;
};

export const SLASH_CARET = "\u0001";
export const SLASH_MARK = "\u0002";

export function parseSlashInsert(text: string): { insert: string; anchor: number; head: number } {
  let insert = text;
  let anchor = insert.length;
  let head = insert.length;
  const start = insert.indexOf(SLASH_CARET);
  if (start < 0) return { insert, anchor, head };
  insert = insert.slice(0, start) + insert.slice(start + 1);
  anchor = head = start;
  const end = insert.indexOf(SLASH_MARK);
  if (end >= 0) {
    insert = insert.slice(0, end) + insert.slice(end + 1);
    head = end;
  }
  return { insert, anchor, head };
}

export type SlashCommandItem = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  group: SlashGroup;
  run: (host: MarkdownHost) => void;
};

export const SLASH_GROUPS: SlashGroup[] = ["常用", "结构", "媒体", "图示"];

function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

const FLOW_TMPL = `\`\`\`mermaid
flowchart TD
  ${SLASH_CARET}A[开始] --> B[结束]
\`\`\``;

const SEQ_TMPL = `\`\`\`mermaid
sequenceDiagram
  ${SLASH_CARET}Alice->>Bob: Hello
  Bob-->>Alice: Hi
\`\`\``;

const MIND_TMPL = `\`\`\`mermaid
mindmap
  ${SLASH_CARET}root((主题))
    分支 A
    分支 B
\`\`\``;

const TABLE_TMPL = `| 列 1 | 列 2 | 列 3 |
| --- | --- | --- |
| ${SLASH_CARET} |  |  |
|  |  |  |`;

function coreSlashCommands(ctx: SlashRuntime): SlashCommandItem[] {
  return [
    {
      id: "paragraph",
      title: "正文",
      description: "普通段落",
      keywords: ["p", "正文", "paragraph", "text"],
      group: "常用",
      run: (host) => host.replaceSlash(""),
    },
    {
      id: "h1",
      title: "一级标题",
      description: "# 标题",
      keywords: ["h1", "title", "标题", "heading"],
      group: "常用",
      run: (host) => host.replaceSlash(`# ${SLASH_CARET}`),
    },
    {
      id: "h2",
      title: "二级标题",
      description: "## 标题",
      keywords: ["h2", "标题", "heading"],
      group: "常用",
      run: (host) => host.replaceSlash(`## ${SLASH_CARET}`),
    },
    {
      id: "h3",
      title: "三级标题",
      description: "### 标题",
      keywords: ["h3", "标题", "heading"],
      group: "常用",
      run: (host) => host.replaceSlash(`### ${SLASH_CARET}`),
    },
    {
      id: "h4",
      title: "四级标题",
      description: "#### 标题",
      keywords: ["h4", "标题", "heading"],
      group: "常用",
      run: (host) => host.replaceSlash(`#### ${SLASH_CARET}`),
    },
    {
      id: "bullet",
      title: "无序列表",
      description: "- 列表项",
      keywords: ["ul", "list", "无序", "列表", "bullet"],
      group: "常用",
      run: (host) => host.replaceSlash(`- ${SLASH_CARET}`),
    },
    {
      id: "ordered",
      title: "有序列表",
      description: "1. 列表项",
      keywords: ["ol", "有序", "列表", "numbered"],
      group: "常用",
      run: (host) => host.replaceSlash(`1. ${SLASH_CARET}`),
    },
    {
      id: "task",
      title: "任务列表",
      description: "- [ ] 待办",
      keywords: ["todo", "task", "任务", "checkbox"],
      group: "常用",
      run: (host) => host.replaceSlash(`- [ ] ${SLASH_CARET}`),
    },
    {
      id: "quote",
      title: "引用",
      description: "> 引用",
      keywords: ["quote", "blockquote", "引用"],
      group: "常用",
      run: (host) => host.replaceSlash(`> ${SLASH_CARET}`),
    },
    {
      id: "code",
      title: "代码块",
      description: "``` 代码",
      keywords: ["code", "代码", "pre"],
      group: "常用",
      run: (host) => host.replaceSlash("```\n" + SLASH_CARET + "\n```"),
    },
    {
      id: "hr",
      title: "分割线",
      description: "---",
      keywords: ["hr", "divider", "分割", "线"],
      group: "常用",
      run: (host) => host.replaceSlash(`---\n${SLASH_CARET}`),
    },
    {
      id: "link",
      title: "链接",
      description: "[文字](url)",
      keywords: ["link", "url", "链接"],
      group: "常用",
      run: (host) => host.replaceSlash(`[${SLASH_CARET}链接文字${SLASH_MARK}](https://)`),
    },
    {
      id: "wikilink",
      title: "双链笔记",
      description: "[[笔记]] 或 [[笔记#标题]]",
      keywords: ["wiki", "wikilink", "双链", "笔记", "obsidian", "[[", "]]"],
      group: "常用",
      run: (host) => {
        host.replaceSlash("");
        host.startWikilink();
      },
    },
    {
      id: "table",
      title: "表格",
      description: "3×3 GFM 表格",
      keywords: ["table", "表格", "grid"],
      group: "结构",
      run: (host) => host.replaceSlash(TABLE_TMPL),
    },
    {
      id: "callout",
      title: "高亮块",
      description: "> [!info] 提示",
      keywords: ["callout", "高亮", "提示", "警告", "info", "tip", "admonition"],
      group: "结构",
      run: (host) => host.replaceSlash(`> [!info] 提示\n> ${SLASH_CARET}`),
    },
    {
      id: "fold",
      title: "折叠块",
      description: ":::fold",
      keywords: ["fold", "折叠", "details", "collapse"],
      group: "结构",
      run: (host) => host.replaceSlash(`:::fold 折叠\n${SLASH_CARET}\n:::`),
    },
    {
      id: "columns",
      title: "分栏",
      description: ":::cols 两栏",
      keywords: ["columns", "分栏", "两栏", "layout", "cols"],
      group: "结构",
      run: (host) => host.replaceSlash(`:::cols\n:::col\n${SLASH_CARET}\n:::\n:::col\n\n:::\n:::`),
    },
    {
      id: "image",
      title: "图片",
      description: "上传并插入图片",
      keywords: ["image", "img", "图片", "photo", "upload"],
      group: "媒体",
      run: (host) => {
        host.replaceSlash("");
        void (async () => {
          const file = await pickImageFile();
          if (!file) return;
          const src = ctx.uploadImage ? await ctx.uploadImage(file) : null;
          if (!src) return;
          host.insert(`![图片](${src})`);
        })();
      },
    },
    {
      id: "math",
      title: "公式",
      description: "$$ LaTeX $$",
      keywords: ["math", "latex", "公式", "katex", "tex"],
      group: "图示",
      run: (host) => host.replaceSlash(`$$\n${SLASH_CARET}E = mc^2${SLASH_MARK}\n$$`),
    },
    {
      id: "mermaid-flow",
      title: "流程图",
      description: "Mermaid flowchart",
      keywords: ["mermaid", "flow", "流程图", "画板", "diagram"],
      group: "图示",
      run: (host) => host.replaceSlash(FLOW_TMPL),
    },
    {
      id: "mermaid-seq",
      title: "时序图",
      description: "Mermaid sequence",
      keywords: ["mermaid", "sequence", "时序", "画板", "uml"],
      group: "图示",
      run: (host) => host.replaceSlash(SEQ_TMPL),
    },
    {
      id: "mermaid-mind",
      title: "思维导图",
      description: "Mermaid mindmap",
      keywords: ["mermaid", "mindmap", "思维导图", "脑图", "画板"],
      group: "图示",
      run: (host) => host.replaceSlash(MIND_TMPL),
    },
  ];
}

function contributedSlashCommands(): SlashCommandItem[] {
  return getContributedSlashItems().map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    keywords: item.keywords,
    group: item.group || "常用",
    run: (host) => {
      if (item.action === "wikilink-suggest") {
        host.replaceSlash("");
        host.startWikilink();
        return;
      }
      host.replaceSlash(item.insertMarkdown || "");
    },
  }));
}

let slashRuntime: SlashRuntime = {};

export function setSlashRuntime(ctx: SlashRuntime) {
  slashRuntime = ctx;
}

export function getSlashCommands(ctx?: SlashRuntime): SlashCommandItem[] {
  const runtime = ctx ?? slashRuntime;
  const map = new Map<string, SlashCommandItem>();
  for (const item of coreSlashCommands(runtime)) map.set(item.id, item);
  for (const item of contributedSlashCommands()) map.set(item.id, item);
  return Array.from(map.values());
}

export const SLASH_COMMANDS = getSlashCommands();

export function filterSlashCommands(query: string, ctx?: SlashRuntime): SlashCommandItem[] {
  const all = getSlashCommands(ctx);
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.keywords.some((k) => k.toLowerCase().includes(q) || k.includes(q)),
  );
}

/** 与菜单展示一致的扁平顺序（按分组），供键盘选中/回车使用 */
export function listSlashCommands(query: string, ctx?: SlashRuntime): SlashCommandItem[] {
  return groupSlashItems(filterSlashCommands(query, ctx)).flatMap(([, list]) => list);
}

export function groupSlashItems(items: SlashCommandItem[]): Array<[SlashGroup, SlashCommandItem[]]> {
  const buckets = new Map<SlashGroup, SlashCommandItem[]>();
  for (const g of SLASH_GROUPS) buckets.set(g, []);
  for (const item of items) {
    const g = item.group || "常用";
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g)!.push(item);
  }
  return [...buckets.entries()].filter(([, list]) => list.length > 0);
}
