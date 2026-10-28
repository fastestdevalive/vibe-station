import { useRef, type HTMLAttributes, type ReactNode } from "react";
import type { ReviewComment } from "@/api/types";
import { PinGutter } from "./CommentPins";
import type { PinMeasurer } from "./pinMeasurer";
import type { MarkSource } from "./rowIndex";
import { usePinHost, useRowPinTargets } from "./usePinHost";

interface PinRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Plain text of the row (the quote's end column is looked up in it). */
  rowText: string;
  /** Comments whose last row this is. */
  pins: readonly ReviewComment[] | undefined;
  /** The open box's span, when this is its last row. */
  draft: MarkSource | undefined;
  activeId: string | null | undefined;
  measurer: PinMeasurer | undefined;
  pinLabel: ((c: ReviewComment) => string) | undefined;
  onPinOpen: ((id: string, el: HTMLElement) => void) | undefined;
  /** Changes whenever the row's rendered text changes (re-measure). */
  contentKey: unknown;
  children: ReactNode;
}

/**
 * A diff row (`.diff-line`) that can carry gutter pins: the row is the pin host, `.diff-line-text` the element
 * whose last character the pin lines up with (it wraps, so the pin follows the wrapped visual line). Rows
 * without comments pay one empty hook, nothing is registered.
 */
export function PinRow({ rowText, pins, draft, activeId, measurer, pinLabel, onPinOpen, contentKey, children, ...div }: PinRowProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const targets = useRowPinTargets(pins, draft, activeId, rowText, pinLabel);
  const placements = usePinHost(measurer, hostRef, ".diff-line-text", targets, contentKey);
  return (
    <div {...div} ref={hostRef}>
      {children}
      <PinGutter placements={placements} targets={targets} onOpen={onPinOpen} />
    </div>
  );
}
