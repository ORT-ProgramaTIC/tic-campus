import type { PresentationState } from "./api/types.ts";
import { STATE_LABEL, STATE_TONE } from "./labels.ts";

/** Pieces more than one screen draws. */

export function StateChip({ state }: { state: PresentationState }) {
  return (
    <span
      className={`rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${STATE_TONE[state]}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}
