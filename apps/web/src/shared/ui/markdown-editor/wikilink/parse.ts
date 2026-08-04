/** 与后端 vault/wikilink.py 对齐：[[target]] / [[target|alias]] / [[note#heading]] */

const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm;

export type WikiLinkMatch = {
  from: number;
  to: number;
  /** 含 #标题 的完整目标（不含 alias） */
  target: string;
  alias: string | null;
  note: string;
  heading: string | null;
  raw: string;
};

export type MarkdownHeading = {
  level: number;
  text: string;
};

export function splitNoteHeading(target: string): { note: string; heading: string | null } {
  let t = (target || "").trim().replace(/\\/g, "/");
  if (t.includes("|")) t = t.split("|", 1)[0].trim();
  const hash = t.indexOf("#");
  if (hash < 0) return { note: t, heading: null };
  const note = t.slice(0, hash).trim();
  const heading = t.slice(hash + 1).trim() || null;
  return { note, heading };
}

export function extractMarkdownHeadings(text: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  const re = new RegExp(HEADING_RE.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ""))) {
    const textTitle = (m[2] || "").trim();
    if (!textTitle) continue;
    out.push({ level: m[1].length, text: textTitle });
  }
  return out;
}

/** 比较标题锚点（忽略空白与大小写；支持末级标题匹配） */
export function headingMatches(anchor: string, headingText: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const a = norm(anchor);
  const h = norm(headingText);
  if (!a || !h) return false;
  if (a === h) return true;
  // [[note#父#子]]：用最后一段匹配
  const last = a.split("#").pop()?.trim() || a;
  return last === h || h.endsWith(last) || a.endsWith(h);
}

export function findWikilinksInText(text: string, baseOffset = 0): WikiLinkMatch[] {
  const out: WikiLinkMatch[] = [];
  const re = new RegExp(WIKILINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const inner = (m[1] || "").trim();
    if (!inner) continue;
    let body = inner;
    let alias: string | null = null;
    if (inner.includes("|")) {
      const parts = inner.split("|");
      body = (parts[0] || "").trim();
      alias = (parts.slice(1).join("|") || "").trim() || null;
    }
    const { note, heading } = splitNoteHeading(body);
    if (!note && !heading) continue;
    const target = body.replace(/\\/g, "/");
    out.push({
      from: baseOffset + m.index,
      to: baseOffset + m.index + m[0].length,
      target,
      alias,
      note,
      heading,
      raw: m[0],
    });
  }
  return out;
}

export function parseWikilinkAt(text: string, index: number): WikiLinkMatch | null {
  for (const hit of findWikilinksInText(text)) {
    if (index >= hit.from && index < hit.to) return hit;
  }
  return null;
}

/** 检测光标是否处于未闭合的 [[query 中 */
export function readOpenWikilinkQuery(
  textBeforeCursor: string,
): { query: string; from: number } | null {
  const open = textBeforeCursor.lastIndexOf("[[");
  if (open < 0) return null;
  const after = textBeforeCursor.slice(open + 2);
  if (after.includes("]]") || after.includes("\n")) return null;
  return { query: after, from: open };
}
