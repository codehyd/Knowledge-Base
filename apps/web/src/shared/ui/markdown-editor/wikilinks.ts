/**
 * Obsidian 风格双链：[[target]] / [[target|alias]]
 * TipTap markdown 往返时，部分版本会把 `[[wikilink]]` 写成 `\[\[wikilink\]\]`。
 * 图谱解析依赖字面双链，导出前还原。
 */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { VaultNode } from "@/shared/api/client";

const WIKILINK_FULL_RE = /\[\[([^\]\n]+?)\]\]/g;

export function restoreWikilinkMarkers(md: string): string {
  if (!md) return "";
  return md
    .replace(/\\\[\\\[([^\]\n]+?)\\\]\\\]/g, "[[$1]]")
    .replace(/\\\[\[/g, "[[")
    .replace(/\]\\\]/g, "]]");
}

/** 从正文提取双链目标（去重，保序） */
export function extractWikilinkTargets(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  WIKILINK_FULL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_FULL_RE.exec(text || ""))) {
    const raw = (m[1] || "").trim();
    const target = (raw.split("|")[0] || "").trim();
    if (!target) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

export type WikiNoteOption = {
  title: string;
  path: string;
  sourceId?: number | null;
};

export function flattenVaultNotes(nodes: VaultNode[]): WikiNoteOption[] {
  const out: WikiNoteOption[] = [];
  const walk = (list: VaultNode[]) => {
    for (const n of list) {
      if (n.kind === "note") {
        const stem = n.name.replace(/\.md$/i, "");
        out.push({
          title: (n.title || stem).trim() || stem,
          path: n.path,
          sourceId: n.source_id,
        });
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  out.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  return out;
}

export function filterWikiNotes(notes: WikiNoteOption[], query: string): WikiNoteOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes.slice(0, 40);
  return notes
    .filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.path.toLowerCase().includes(q) ||
        n.path.replace(/\.md$/i, "").split("/").pop()?.toLowerCase().includes(q),
    )
    .slice(0, 40);
}

/** 光标前未闭合的 [[query */
export function readWikilinkQuery(
  editor: Editor,
): { query: string; from: number; to: number } | null {
  const { from } = editor.state.selection;
  const $from = editor.state.doc.resolve(from);
  if (!$from.parent.isTextblock) return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const match = /\[\[([^\]\n]*)$/.exec(textBefore);
  if (!match) return null;
  return {
    query: match[1] || "",
    from: from - match[0].length,
    to: from,
  };
}

export function insertWikilink(editor: Editor, target: string, range?: { from: number; to: number }) {
  const name = target.trim() || "笔记名";
  const content = `[[${name}]]`;
  if (range) {
    editor.chain().focus().deleteRange(range).insertContent(content).run();
  } else {
    editor.chain().focus().insertContent(content).run();
  }
}

/** 编辑器内高亮已完成的 [[…]]，让用户一眼看出双链已写入 */
export const WikilinkHighlight = Extension.create({
  name: "wikilinkHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("wikilinkHighlight"),
        props: {
          decorations(state) {
            const decorations: ReturnType<typeof Decoration.inline>[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              const text = node.text;
              WIKILINK_FULL_RE.lastIndex = 0;
              let match: RegExpExecArray | null;
              while ((match = WIKILINK_FULL_RE.exec(text))) {
                const from = pos + match.index;
                const to = from + match[0].length;
                const raw = (match[1] || "").trim();
                const target = (raw.split("|")[0] || "").trim();
                decorations.push(
                  Decoration.inline(from, to, {
                    class: "wikilink",
                    title: target ? `双链 → ${target}` : "双链",
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
