import { forwardRef } from "react";
import { StatusDot } from "@/components/layout/StatusDot";
import { Chip } from "@/components/ui/Chip";
import type { WorktreeRolledUpStatus } from "@/lib/worktreeStatus";
import type { SessionState } from "@/api/types";
import type { PickerRowModel } from "./pickerEligibility";

const DOT: Record<SessionState, WorktreeRolledUpStatus> = {
  working: "working",
  idle: "idle",
  waiting_for_human: "waiting_for_human",
  not_started: "spawning",
  done: "done",
  exited: "exited",
  drafting: "none",
};

interface ReviewPickerRowProps {
  row: PickerRowModel;
  selected: boolean;
  /** Roving tabindex: the selected row (or the first enabled one when nothing is selected) is the tab stop. */
  tabStop: boolean;
  onSelect: () => void;
}

/**
 * One agent in the send picker: a radio row (dot, name, kind chip, state / reason text) with no buttons inside;
 * the whole row selects it. A disabled row keeps its reason, cannot be selected and is skipped by the arrow keys.
 */
export const ReviewPickerRow = forwardRef<HTMLDivElement, ReviewPickerRowProps>(function ReviewPickerRow(
  { row, selected, tabStop, onSelect },
  ref,
) {
  const disabled = row.disabled || row.target === "none";
  return (
    <div
      ref={ref}
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      tabIndex={tabStop && !disabled ? 0 : -1}
      className={`comment-picker__row${disabled ? " comment-picker__row--disabled" : ""}${selected ? " comment-picker__row--selected" : ""}`}
      data-session-id={row.id}
      onClick={disabled ? undefined : onSelect}
    >
      <span className="comment-picker__dot" aria-hidden>
        {selected ? <span className="comment-picker__dot-fill" /> : null}
      </span>
      <StatusDot status={DOT[row.state]} />
      <span className="comment-picker__name" title={row.name}>{row.name}</span>
      <Chip tone="neutral">{row.chip}</Chip>
      <span className={`comment-picker__why${row.warn ? " comment-picker__why--warn" : ""}`}>{row.why}</span>
    </div>
  );
});
