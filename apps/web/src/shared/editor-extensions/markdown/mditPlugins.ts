import markdownit from "markdown-it";
import type MarkdownIt from "markdown-it";

/** 块规则里不要对同一实例 `md.render()`，否则会弄脏 parser state。 */
function nestedMarkdown(md: MarkdownIt): MarkdownIt {
  const bag = md as MarkdownIt & { __kkChild?: MarkdownIt };
  if (bag.__kkChild) return bag.__kkChild;
  const child = markdownit(md.options);
  bag.__kkChild = child;
  applyDialectPlugins(child);
  return child;
}

function renderBlock(md: MarkdownIt, src: string): string {
  if (!String(src || "").trim()) return "<p></p>";
  return nestedMarkdown(md).render(src);
}

function renderInline(md: MarkdownIt, src: string): string {
  return nestedMarkdown(md).renderInline(src || "");
}

function escapeAttr(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function lineText(state: { src: string; bMarks: number[]; eMarks: number[]; tShift: number[] }, line: number) {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  if (cells.length < 1) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c.replace(/\s/g, "")));
}

/** GFM 表格 → HTML table（供 TipTap Table / 预览共用） */
export function gfmTablePlugin(md: MarkdownIt) {
  md.block.ruler.before("paragraph", "gfm_table", (state, startLine, endLine, silent) => {
    const first = lineText(state, startLine);
    if (!first.includes("|")) return false;
    if (startLine + 1 >= endLine) return false;
    const delim = lineText(state, startLine + 1);
    if (!isDelimiterRow(delim)) return false;
    const headers = splitRow(first);
    if (!headers.length) return false;

    const rows: string[][] = [];
    let next = startLine + 2;
    while (next < endLine) {
      const raw = lineText(state, next);
      if (!raw.includes("|") || !raw.trim()) break;
      if (isDelimiterRow(raw)) break;
      rows.push(splitRow(raw));
      next += 1;
    }
    if (silent) return true;

    const th = headers
      .map((h) => `<th>${md.utils.escapeHtml(h)}</th>`)
      .join("");
    const body = rows
      .map((cells) => {
        const tds = headers
          .map((_, i) => `<td>${renderInline(md, cells[i] || "")}</td>`)
          .join("");
        return `<tr>${tds}</tr>`;
      })
      .join("");
    const token = state.push("html_block", "", 0);
    token.content = `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
    token.map = [startLine, next];
    state.line = next;
    return true;
  });
}

const CALLOUT_LINE = /^>\s*\[!([a-zA-Z0-9_-]+)\][ \t]*(.*)$/;

export function calloutPlugin(md: MarkdownIt) {
  md.block.ruler.before("blockquote", "obsidian_callout", (state, startLine, endLine, silent) => {
    const first = lineText(state, startLine);
    const hit = CALLOUT_LINE.exec(first);
    if (!hit) return false;
    if (silent) return true;
    const type = hit[1].toLowerCase();
    const title = (hit[2] || "").trim() || type;
    const body: string[] = [];
    let next = startLine + 1;
    while (next < endLine) {
      const raw = state.src.slice(state.bMarks[next], state.eMarks[next]);
      if (!raw.startsWith(">")) break;
      body.push(raw.replace(/^>\s?/, ""));
      next += 1;
    }
    const inner = renderBlock(md, body.join("\n"));
    const token = state.push("html_block", "", 0);
    token.content = `<div data-type="callout" data-callout="${escapeAttr(type)}" data-title="${escapeAttr(title)}">${inner}</div>`;
    token.map = [startLine, next];
    state.line = next;
    return true;
  });
}

function parseFenceBlock(
  state: {
    src: string;
    bMarks: number[];
    eMarks: number[];
    tShift: number[];
    line: number;
    push: (type: string, tag: string, nesting: number) => { content: string; map: number[] };
  },
  startLine: number,
  endLine: number,
  name: string,
): { title: string; body: string; next: number } | null {
  const open = lineText(state, startLine);
  const hit = new RegExp(`^:::${name}(?:[ \\t]+(.*))?$`).exec(open.trimEnd());
  if (!hit) return null;
  const title = (hit[1] || "").trim();
  const bodyLines: string[] = [];
  let next = startLine + 1;
  let depth = 1;
  while (next < endLine) {
    const raw = lineText(state, next).trimEnd();
    if (/^:::[a-zA-Z]/.test(raw)) depth += 1;
    else if (raw.trim() === ":::") {
      depth -= 1;
      if (depth === 0) {
        next += 1;
        return { title, body: bodyLines.join("\n"), next };
      }
    }
    bodyLines.push(state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]));
    next += 1;
  }
  return null;
}

export function foldPlugin(md: MarkdownIt) {
  md.block.ruler.before("fence", "fold_block", (state, startLine, endLine, silent) => {
    const parsed = parseFenceBlock(state, startLine, endLine, "fold");
    if (!parsed) return false;
    if (silent) return true;
    const inner = renderBlock(md, parsed.body);
    const token = state.push("html_block", "", 0);
    token.content = `<div data-type="fold" data-title="${escapeAttr(parsed.title || "折叠")}">${inner}</div>`;
    token.map = [startLine, parsed.next];
    state.line = parsed.next;
    return true;
  });
}

export function columnsPlugin(md: MarkdownIt) {
  md.block.ruler.before("fence", "cols_block", (state, startLine, endLine, silent) => {
    const open = lineText(state, startLine).trimEnd();
    if (open !== ":::cols") return false;
    if (silent) return true;
    const cols: string[] = [];
    let next = startLine + 1;
    let current: string[] | null = null;
    let closed = false;
    while (next < endLine) {
      const raw = lineText(state, next).trimEnd();
      if (raw === ":::col") {
        if (current) cols.push(current.join("\n"));
        current = [];
        next += 1;
        continue;
      }
      if (raw === ":::") {
        if (current) {
          cols.push(current.join("\n"));
          current = null;
          next += 1;
          if (lineText(state, next)?.trimEnd() === ":::") {
            next += 1;
            closed = true;
            break;
          }
          continue;
        }
        next += 1;
        closed = true;
        break;
      }
      if (current) current.push(state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]));
      else if (raw.trim()) return false;
      next += 1;
    }
    if (!closed || cols.length < 2) return false;
    const inner = cols
      .map((body) => `<div data-type="column">${renderBlock(md, body)}</div>`)
      .join("");
    const token = state.push("html_block", "", 0);
    token.content = `<div data-type="columns">${inner}</div>`;
    token.map = [startLine, next];
    state.line = next;
    return true;
  });
}

export function mathPlugin(md: MarkdownIt) {
  md.block.ruler.before("fence", "math_block", (state, startLine, endLine, silent) => {
    const first = lineText(state, startLine).trim();
    if (first === "$$") {
      const lines: string[] = [];
      let next = startLine + 1;
      while (next < endLine) {
        const raw = lineText(state, next);
        if (raw.trim() === "$$") {
          if (silent) return true;
          const token = state.push("html_block", "", 0);
          token.content = `<div data-type="math" data-display="block" data-latex="${escapeAttr(lines.join("\n"))}"></div>`;
          token.map = [startLine, next + 1];
          state.line = next + 1;
          return true;
        }
        lines.push(state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]));
        next += 1;
      }
      return false;
    }
    const one = /^\$\$([^$]+)\$\$$/.exec(first);
    if (!one) return false;
    if (silent) return true;
    const token = state.push("html_block", "", 0);
    token.content = `<div data-type="math" data-display="block" data-latex="${escapeAttr(one[1].trim())}"></div>`;
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  });

  md.inline.ruler.after("escape", "math_inline", (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) return false;
    if (state.src.charCodeAt(state.pos + 1) === 0x24) return false;
    const start = state.pos + 1;
    if (state.src[start] === " " || state.src[start] === "\n") return false;
    let end = start;
    while (end < state.posMax) {
      if (state.src.charCodeAt(end) === 0x24 && state.src.charCodeAt(end - 1) !== 0x5c) break;
      end += 1;
    }
    if (end >= state.posMax || end === start) return false;
    if (state.src[end - 1] === " ") return false;
    if (end + 1 < state.posMax && /\d/.test(state.src[end + 1])) return false;
    const latex = state.src.slice(start, end);
    if (!latex || /\n/.test(latex) || latex.length > 200) return false;
    if (!silent) {
      const token = state.push("html_inline", "", 0);
      token.content = `<span data-type="math" data-display="inline" data-latex="${escapeAttr(latex)}"></span>`;
    }
    state.pos = end + 1;
    return true;
  });
}

export function applyDialectPlugins(md: MarkdownIt) {
  const flag = md as MarkdownIt & { __kongkuDialect?: boolean };
  if (flag.__kongkuDialect) return;
  flag.__kongkuDialect = true;
  md.use(gfmTablePlugin);
  md.use(calloutPlugin);
  md.use(foldPlugin);
  md.use(columnsPlugin);
  md.use(mathPlugin);
}
