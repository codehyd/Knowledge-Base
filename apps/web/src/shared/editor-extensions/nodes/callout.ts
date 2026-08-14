import { Node, mergeAttributes } from "@tiptap/core";

const LABELS: Record<string, string> = {
  info: "提示",
  tip: "提示",
  note: "笔记",
  warning: "警告",
  danger: "危险",
};

export const CalloutNode = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      type: { default: "info" },
      title: { default: "" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-type='callout']",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          return {
            type: el.getAttribute("data-callout") || "info",
            title: el.getAttribute("data-title") || "",
          };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const type = String(node.attrs.type || "info");
    const title = String(node.attrs.title || LABELS[type] || "提示");
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "callout",
        "data-callout": type,
        "data-title": title,
        class: `kk-callout kk-callout-${type}`,
      }),
      ["div", { class: "kk-callout-label", contenteditable: "false" }, title],
      ["div", { class: "kk-callout-body" }, 0],
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const type = node.attrs.type || "info";
          const title = String(node.attrs.title || "").trim();
          state.write(`> [!${type}]${title ? ` ${title}` : ""}\n`);
          state.wrapBlock("> ", null, node, () => state.renderContent(node));
        },
      },
    };
  },
});
