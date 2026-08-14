import { Node, mergeAttributes } from "@tiptap/core";

export const ColumnNode = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  parseHTML() {
    return [{ tag: "div[data-type='column']" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "column", class: "kk-col" }), 0];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(":::col\n");
          state.renderContent(node);
          state.ensureNewLine();
          state.write(":::");
          state.closeBlock(node);
        },
      },
    };
  },
});

export const ColumnsNode = Node.create({
  name: "columns",
  group: "block",
  content: "column+",
  isolating: true,
  parseHTML() {
    return [{ tag: "div[data-type='columns']" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "columns", class: "kk-cols" }), 0];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(":::cols\n");
          node.forEach((col: any) => {
            state.write(":::col\n");
            state.renderContent(col);
            state.ensureNewLine();
            state.write(":::\n");
          });
          state.write(":::");
          state.closeBlock(node);
        },
      },
    };
  },
});
