/**
 * Obsidian 风格双链：[[target]] / [[target|alias]]
 */
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
