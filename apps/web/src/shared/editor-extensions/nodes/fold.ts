import { Node, mergeAttributes } from "@tiptap/core";

export const FoldNode = Node.create({
  name: "fold",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      title: { default: "折叠" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-type='fold']",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          return { title: el.getAttribute("data-title") || "折叠" };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const title = String(node.attrs.title || "折叠");
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "fold",
        "data-title": title,
        class: "kk-fold",
      }),
      ["div", { class: "kk-fold-title", contenteditable: "false" }, title],
      ["div", { class: "kk-fold-body" }, 0],
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`:::fold ${node.attrs.title || "折叠"}\n`);
          state.renderContent(node);
          state.ensureNewLine();
          state.write(":::");
          state.closeBlock(node);
        },
      },
    };
  },
});
