import { api, type VaultLinkTarget } from "@/shared/api/client";
import { splitNoteHeading } from "./parse";

function normalizeNote(target: string) {
  const { note } = splitNoteHeading(target);
  let t = (note || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (t.toLowerCase().endsWith(".md")) t = t.slice(0, -3);
  return t;
}

export async function resolveVaultLinkTarget(target: string): Promise<VaultLinkTarget | null> {
  const q = normalizeNote(target);
  if (!q) return null;
  const res = await api.getVaultLinkTargets({ q, limit: 12 });
  const items = res.items;
  if (!items.length) return null;

  const qLower = q.toLowerCase();
  const exact =
    items.find((it) => {
      const pathNorm = it.path.replace(/\.md$/i, "").toLowerCase();
      return (
        it.title.toLowerCase() === qLower ||
        (it.stem || "").toLowerCase() === qLower ||
        it.path.toLowerCase() === qLower ||
        pathNorm === qLower ||
        pathNorm.endsWith(`/${qLower}`)
      );
    }) || items[0];

  return exact;
}

/** 解析并返回可导航的 notes 查询（优先 source_id；可带 heading） */
export async function resolveWikilinkHref(target: string): Promise<string | null> {
  const { heading } = splitNoteHeading(target);
  const hit = await resolveVaultLinkTarget(target);
  if (!hit) return null;
  const params = new URLSearchParams();
  if (hit.source_id != null) {
    params.set("id", String(hit.source_id));
  } else {
    try {
      const note = await api.registerVaultPath(hit.path);
      params.set("id", String(note.source_id));
    } catch {
      return null;
    }
  }
  if (heading) params.set("heading", heading);
  return `/notes?${params.toString()}`;
}
