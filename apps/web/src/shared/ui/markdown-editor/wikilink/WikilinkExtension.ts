import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findWikilinksInText } from "./parse";

export const wikilinkPluginKey = new PluginKey("kongku-wikilink");

export type WikilinkSuggestState = {
  active: boolean;
  query: string;
  from: number;
  to: number;
  left: number;
  top: number;
};

type WikilinkOptions = {
  onSuggest?: (state: WikilinkSuggestState | null) => void;
  onOpenLink?: (target: string) => void;
};

function buildDecorations(doc: Parameters<typeof DecorationSet.create>[0]) {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const hit of findWikilinksInText(node.text, pos)) {
      decorations.push(
        Decoration.inline(hit.from, hit.to, {
          class: "kk-wikilink",
          "data-wikilink-target": hit.target,
          title: hit.target,
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const WikilinkExtension = Extension.create<WikilinkOptions>({
  name: "kongkuWikilink",

  addOptions() {
    return {
      onSuggest: undefined,
      onOpenLink: undefined,
    };
  },

  addProseMirrorPlugins() {
    const extension = this;
    return [
      new Plugin({
        key: wikilinkPluginKey,
        state: {
          init: (_, state) => buildDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return wikilinkPluginKey.getState(state);
          },
          handleClick(view, pos, event) {
            const target = (event.target as HTMLElement | null)?.closest?.(
              ".kk-wikilink",
            ) as HTMLElement | null;
            if (!target) return false;
            const linkTarget = target.getAttribute("data-wikilink-target");
            if (!linkTarget) return false;
            event.preventDefault();
            extension.options.onOpenLink?.(linkTarget);
            return true;
          },
        },
        view() {
          return {
            update(view) {
              try {
                const { from } = view.state.selection;
                const $from = view.state.doc.resolve(from);
                if (!$from.parent.isTextblock) {
                  extension.options.onSuggest?.(null);
                  return;
                }
                const parentStart = $from.start();
                const textBefore = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
                const open = textBefore.lastIndexOf("[[");
                if (open < 0) {
                  extension.options.onSuggest?.(null);
                  return;
                }
                const after = textBefore.slice(open + 2);
                if (after.includes("]]") || after.includes("\n")) {
                  extension.options.onSuggest?.(null);
                  return;
                }
                const absFrom = parentStart + open;
                const coords = view.coordsAtPos(from);
                extension.options.onSuggest?.({
                  active: true,
                  query: after,
                  from: absFrom,
                  to: from,
                  left: Math.min(coords.left, window.innerWidth - 320),
                  top: Math.min(coords.bottom + 6, window.innerHeight - 280),
                });
              } catch {
                extension.options.onSuggest?.(null);
              }
            },
          };
        },
      }),
    ];
  },
});
