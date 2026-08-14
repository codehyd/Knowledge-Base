import { Node, mergeAttributes } from "@tiptap/core";
import type { NodeViewRenderer } from "@tiptap/core";
import katex from "katex";

function serializeMath(state: any, node: any) {
  const latex = String(node.attrs.latex || "").trim();
  if (node.type.name === "mathInline") {
    state.write(`$${latex}$`);
    return;
  }
  state.write(`$$\n${latex}\n$$`);
  state.closeBlock(node);
}

const mathAttrs = {
  latex: { default: "" },
};

function paintKatex(el: HTMLElement, latex: string, display: "block" | "inline") {
  try {
    el.innerHTML = katex.renderToString(latex || "\\dots", {
      throwOnError: false,
      displayMode: display === "block",
    });
  } catch {
    el.textContent = latex || "公式";
  }
}

function mathNodeView(display: "block" | "inline"): NodeViewRenderer {
  return ({ node, editor, getPos }) => {
    const el = document.createElement(display === "inline" ? "span" : "div");
    el.className = `kk-math kk-math-${display}`;
    el.setAttribute("data-type", "math");
    el.setAttribute("contenteditable", "false");
    el.title = "点击编辑公式";
    el.textContent = String(node.attrs.latex || "") || "公式";
    let paintId = 0;
    const paint = (latex: string, immediate = false) => {
      if (paintId) cancelAnimationFrame(paintId);
      const run = () => paintKatex(el, latex, display);
      if (immediate) {
        run();
        return;
      }
      paintId = requestAnimationFrame(run);
    };
    paint(String(node.attrs.latex || ""));
    el.addEventListener("click", () => {
      const current = String(node.attrs.latex || "");
      const next = window.prompt("LaTeX 公式", current);
      if (next == null) return;
      const pos = getPos();
      if (typeof pos !== "number") return;
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { latex: next.trim(), display });
          return true;
        })
        .run();
    });
    return {
      dom: el,
      update(updated) {
        if (updated.type.name !== node.type.name) return false;
        node = updated;
        paint(String(updated.attrs.latex || ""), true);
        return true;
      },
      destroy() {
        if (paintId) cancelAnimationFrame(paintId);
      },
    };
  };
}

export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { ...mathAttrs, display: { default: "block" } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-type='math']",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          return { latex: el.getAttribute("data-latex") || "", display: "block" };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "math",
        "data-display": "block",
        "data-latex": node.attrs.latex || "",
        class: "kk-math kk-math-block",
      }),
    ];
  },
  addNodeView() {
    return mathNodeView("block");
  },
  addStorage() {
    return { markdown: { serialize: serializeMath } };
  },
});

export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { ...mathAttrs, display: { default: "inline" } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-type='math']",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          return { latex: el.getAttribute("data-latex") || "", display: "inline" };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "math",
        "data-display": "inline",
        "data-latex": node.attrs.latex || "",
        class: "kk-math kk-math-inline",
      }),
    ];
  },
  addNodeView() {
    return mathNodeView("inline");
  },
  addStorage() {
    return { markdown: { serialize: serializeMath } };
  },
});
