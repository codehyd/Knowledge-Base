import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";
import "katex/dist/katex.min.css";

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "cm-md-h1",
  ATXHeading2: "cm-md-h2",
  ATXHeading3: "cm-md-h3",
  ATXHeading4: "cm-md-h4",
  ATXHeading5: "cm-md-h5",
  ATXHeading6: "cm-md-h6",
  SetextHeading1: "cm-md-h1",
  SetextHeading2: "cm-md-h2",
};

const HIDE_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark",
  "StrikethroughMark",
]);

const hideMark = Decoration.replace({});
const wikiMark = Decoration.mark({ class: "cm-md-wiki" });

class MathWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return this.latex === other.latex && this.display === other.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-md-math-block" : "cm-md-math-inline";
    try {
      el.innerHTML = katex.renderToString(this.latex || "\\dots", {
        throwOnError: false,
        displayMode: this.display,
      });
    } catch {
      el.textContent = this.latex || "公式";
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-bullet";
    el.textContent = "•";
    return el;
  }
  eq() {
    return true;
  }
}

class CheckWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }
  eq(other: CheckWidget) {
    return this.checked === other.checked && this.from === other.from && this.to === other.to;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-check";
    box.checked = this.checked;
    box.tabIndex = -1;
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = this.checked ? "[ ]" : "[x]";
      view.dispatch({ changes: { from: this.from, to: this.to, insert: next } });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class HrWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("hr");
    el.className = "cm-md-hr";
    return el;
  }
  eq() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return this.url === other.url && this.alt === other.alt;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-image-wrap";
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.url;
    img.alt = this.alt;
    img.draggable = false;
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

type Piece = { from: number; to: number; spec: Decoration; kind: "line" | "mark" | "replace" };

function overlaps(from: number, to: number, a: number, b: number) {
  return from < b && to > a;
}

function addMath(pieces: Piece[], from: number, to: number, latex: string, display: boolean) {
  if (from >= to) return;
  pieces.push({
    from,
    to,
    spec: Decoration.replace({ widget: new MathWidget(latex, display), block: display }),
    kind: "replace",
  });
}

function forEachLine(
  doc: { lineAt: (n: number) => { from: number; to: number; text: string } },
  from: number,
  to: number,
  fn: (line: { from: number; to: number; text: string }) => void,
) {
  if (to <= from) return;
  let pos = from;
  while (pos < to) {
    const line = doc.lineAt(pos);
    fn(line);
    const next = line.to + 1;
    if (next >= to) break;
    pos = next;
  }
}

function paintLine(pieces: Piece[], lineFrom: number, className: string) {
  pieces.push({
    from: lineFrom,
    to: lineFrom,
    spec: Decoration.line({ class: className }),
    kind: "line",
  });
}

function isFenceLine(text: string) {
  const t = text.trim();
  return t.startsWith("```") || t.startsWith("~~~");
}

function isQuoteLine(text: string) {
  return /^\s{0,3}>\s*\S/.test(text);
}

function isTableLine(text: string) {
  return text.includes("|") && text.trim().length > 0;
}

function buildDecos(view: EditorView): DecorationSet {
  const { state } = view;
  const sel = state.selection.main;
  const activeFrom = state.doc.lineAt(sel.from).from;
  const activeTo = state.doc.lineAt(sel.to).to;
  const pieces: Piece[] = [];

  const hideIfIdle = (from: number, to: number) => {
    if (from >= to) return;
    if (overlaps(from, to, activeFrom, activeTo)) return;
    pieces.push({ from, to, spec: hideMark, kind: "replace" });
  };

  for (const range of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        const name = node.name;
        const heading = HEADING_CLASS[name];
        if (heading) {
          forEachLine(state.doc, node.from, node.to, (line) => {
            if (line.text.trim()) paintLine(pieces, line.from, heading);
          });
        }

        if (name === "Blockquote") {
          forEachLine(state.doc, node.from, node.to, (line) => {
            if (isQuoteLine(line.text)) paintLine(pieces, line.from, "cm-md-quote");
          });
        }

        if (name === "FencedCode") {
          let open = false;
          forEachLine(state.doc, node.from, node.to, (line) => {
            if (isFenceLine(line.text)) {
              paintLine(pieces, line.from, "cm-md-codeblock");
              open = !open;
              return;
            }
            if (open) paintLine(pieces, line.from, "cm-md-codeblock");
          });
        }

        if (name === "Table") {
          forEachLine(state.doc, node.from, node.to, (line) => {
            if (isTableLine(line.text)) paintLine(pieces, line.from, "cm-md-table");
          });
        }

        if (name === "HorizontalRule" && !overlaps(node.from, node.to, activeFrom, activeTo)) {
          pieces.push({ from: node.from, to: node.to, spec: Decoration.replace({ widget: new HrWidget() }), kind: "replace" });
          return false;
        }

        if (name === "Image" && !overlaps(node.from, node.to, activeFrom, activeTo)) {
          const raw = state.doc.sliceString(node.from, node.to);
          const parsed = /^!\[(.*?)\]\((.*?)\)/.exec(raw);
          const alt = parsed?.[1] ?? "";
          const url = parsed?.[2] ?? "";
          if (url) {
            pieces.push({
              from: node.from,
              to: node.to,
              spec: Decoration.replace({ widget: new ImageWidget(url, alt) }),
              kind: "replace",
            });
            return false;
          }
        }

        if (name === "TaskMarker" && !overlaps(node.from, node.to, activeFrom, activeTo)) {
          const raw = state.doc.sliceString(node.from, node.to);
          const checked = /\[[xX]\]/.test(raw);
          pieces.push({
            from: node.from,
            to: node.to,
            spec: Decoration.replace({ widget: new CheckWidget(checked, node.from, node.to) }),
            kind: "replace",
          });
          return false;
        }

        if (name === "ListMark") {
          const line = state.doc.lineAt(node.from);
          const isTask = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line.text);
          if (isTask) {
            hideIfIdle(node.from, node.to);
            return;
          }
          const mark = state.doc.sliceString(node.from, node.to);
          if (!overlaps(node.from, node.to, activeFrom, activeTo) && !/^\d/.test(mark)) {
            pieces.push({ from: node.from, to: node.to, spec: Decoration.replace({ widget: new BulletWidget() }), kind: "replace" });
            return;
          }
        }

        if (HIDE_MARKS.has(name)) {
          if (name === "CodeMark" && node.node.parent?.name === "FencedCode") return;
          let to = node.to;
          if (name === "HeaderMark") {
            const line = state.doc.lineAt(node.from);
            while (to < line.to && state.doc.sliceString(to, to + 1) === " ") to += 1;
          }
          hideIfIdle(node.from, to);
        }
      },
    });

    const fromLine = state.doc.lineAt(range.from).number;
    const toLine = state.doc.lineAt(range.to).number;
    for (let n = fromLine; n <= toLine; n++) {
      const line = state.doc.line(n);
      const idle = !overlaps(line.from, line.to, activeFrom, activeTo);
      if (/^>\s*\[!(?:info|tip|note|warning|danger|success)\]/i.test(line.text)) {
        paintLine(pieces, line.from, "cm-md-callout");
      }
      if (/^:::(?:fold|cols|col)?\b/.test(line.text.trim())) {
        paintLine(pieces, line.from, "cm-md-fence");
      }

      const trimmed = line.text.trim();
      const oneLineBlock = /^\$\$([^$]+)\$\$$/.exec(trimmed);
      if (oneLineBlock) {
        if (idle) {
          const to = n < state.doc.lines ? line.to + 1 : line.to;
          addMath(pieces, line.from, to, oneLineBlock[1].trim(), true);
        }
        continue;
      }
      if (trimmed === "$$") {
        const parts: string[] = [];
        let closed = 0;
        for (let j = n + 1; j <= state.doc.lines && j <= n + 80; j++) {
          const L = state.doc.line(j);
          if (L.text.trim() === "$$") {
            closed = j;
            break;
          }
          parts.push(L.text);
        }
        if (closed) {
          const last = state.doc.line(closed);
          const to = closed < state.doc.lines ? last.to + 1 : last.to;
          if (!overlaps(line.from, to, activeFrom, activeTo)) {
            addMath(pieces, line.from, to, parts.join("\n"), true);
          }
          n = closed;
        }
        continue;
      }

      if (!idle) continue;

      const wikiRe = /\[\[([^\]\n]+?)\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = wikiRe.exec(line.text))) {
        const from = line.from + m.index;
        const to = from + m[0].length;
        hideIfIdle(from, from + 2);
        hideIfIdle(to - 2, to);
        if (to - 2 > from + 2) pieces.push({ from: from + 2, to: to - 2, spec: wikiMark, kind: "mark" });
      }

      const mathRe = /(?<!\$)\$(?!\$)([^$\n]+)\$(?!\$)/g;
      while ((m = mathRe.exec(line.text))) {
        const from = line.from + m.index;
        const to = from + m[0].length;
        addMath(pieces, from, to, m[1], false);
      }
    }
  }

  pieces.sort((a, b) => a.from - b.from || a.to - b.to || (a.kind === "line" ? -1 : 1));
  const kept: Piece[] = [];
  let replaceUntil = -1;
  for (const piece of pieces) {
    if (piece.kind === "replace") {
      if (piece.from < replaceUntil) continue;
      replaceUntil = piece.to;
    } else if (piece.kind !== "line" && piece.from < replaceUntil && piece.to <= replaceUntil) {
      continue;
    }
    kept.push(piece);
  }
  try {
    return Decoration.set(
      kept.map((piece) => (piece.from === piece.to ? piece.spec.range(piece.from) : piece.spec.range(piece.from, piece.to))),
      true,
    );
  } catch {
    return Decoration.none;
  }
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      try {
        this.decorations = buildDecos(view);
      } catch {
        this.decorations = Decoration.none;
      }
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        try {
          this.decorations = buildDecos(update.view);
        } catch {
          this.decorations = Decoration.none;
        }
      }
    }
  },
  { decorations: (v) => v.decorations },
);
