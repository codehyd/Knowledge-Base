import type { Editor } from "@tiptap/react";
import { NoteLinkPicker } from "@/shared/ui/note-link";
import type { WikilinkSuggestState } from "./WikilinkExtension";

type Props = {
  editor: Editor;
  state: WikilinkSuggestState;
  excludeSourceId?: number | null;
  onClose: () => void;
};

export function WikilinkSuggest({ editor, state, excludeSourceId = null, onClose }: Props) {
  return (
    <NoteLinkPicker
      open={state.active}
      left={state.left}
      top={state.top}
      initialQuery={state.query}
      excludeSourceId={excludeSourceId}
      onClose={onClose}
      onPick={(label) => {
        const text = `[[${label}]]`;
        editor
          .chain()
          .focus()
          .deleteRange({ from: state.from, to: state.to })
          .insertContent(text)
          .run();
        onClose();
      }}
    />
  );
}

/** 从 slash / 外部打开：在光标处插入 [[ 并唤起建议（由插件 view 接管） */
export function startWikilinkSuggest(editor: Editor) {
  editor.chain().focus().insertContent("[[").run();
}
