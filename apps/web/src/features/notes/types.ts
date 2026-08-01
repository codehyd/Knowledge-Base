import type { VaultNode, VaultNote } from "@/shared/api/client";

export type NoteTab = {
  sourceId: number;
  title: string;
  path: string;
  note: VaultNote;
  draftTitle: string;
  draftContent: string;
  draftLake: string | null;
  dirty: boolean;
};

export type CtxMenuTarget =
  | { kind: "root" }
  | { kind: "folder"; path: string; name: string }
  | { kind: "note"; path: string; name: string; sourceId: number | null; title: string };

export type CtxMenuState = {
  x: number;
  y: number;
  target: CtxMenuTarget;
};

export function findNote(nodes: VaultNode[], sourceId: number): VaultNode | null {
  for (const n of nodes) {
    if (n.kind === "note" && n.source_id === sourceId) return n;
    if (n.children?.length) {
      const hit = findNote(n.children, sourceId);
      if (hit) return hit;
    }
  }
  return null;
}

export function tabFromNote(res: VaultNote): NoteTab {
  return {
    sourceId: res.source_id,
    title: res.title || "",
    path: res.path,
    note: res,
    draftTitle: res.title || "",
    draftContent: res.content,
    draftLake: res.source_lake ?? null,
    dirty: false,
  };
}
