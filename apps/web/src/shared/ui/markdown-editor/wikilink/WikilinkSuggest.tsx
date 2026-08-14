import { NoteLinkPicker } from "@/shared/ui/note-link";

export type WikilinkSuggestState = {
  active: boolean;
  query: string;
  from: number;
  to: number;
  left: number;
  top: number;
};

type Props = {
  state: WikilinkSuggestState;
  excludeSourceId?: number | null;
  onClose: () => void;
  onPick: (label: string) => void;
};

export function WikilinkSuggest({ state, excludeSourceId = null, onClose, onPick }: Props) {
  return (
    <NoteLinkPicker
      open={state.active}
      left={state.left}
      top={state.top}
      initialQuery={state.query}
      excludeSourceId={excludeSourceId}
      onClose={onClose}
      onPick={(label) => {
        onPick(label);
        onClose();
      }}
    />
  );
}
