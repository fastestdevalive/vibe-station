import { MessageSquare } from "lucide-react";
import { useCallback, useRef, type CSSProperties } from "react";
import type { ReviewComment } from "@/api/types";
import type { PinPlacement } from "./pinGeometry";
import type { PinTarget } from "./pinMeasurer";

/** Pin label for assistive tech: `Comment #9 (3 of 5): <text>` plus `, outdated` (`#9` is the pin: the list / message id). */
export function pinAriaLabel(c: ReviewComment, ordinal: number, total: number): string {
  const text = c.text.length > 80 ? `${c.text.slice(0, 80)}…` : c.text;
  return `Comment #${c.pin} (${ordinal} of ${total}): ${text}${c.anchor === "outdated" ? ", outdated" : ""}`;
}

/** The comment icon every marker shows (sized by CSS); the pin number is only `data-pin` and the label. */
const PinIcon = () => <MessageSquare className="comment-pin__icon" strokeWidth={3} aria-hidden focusable="false" />;

interface PinGutterProps {
  placements: readonly PinPlacement[];
  /** The host's pin targets (member data by id; a placement may outlive a removed target by one frame). */
  targets: readonly PinTarget[];
  /** Code / diff: open the comment's card. Omitted for markdown (its delegated click handles pins). */
  onOpen?: (id: string, el: HTMLElement) => void;
  /** Code view only: registers the stack so its horizontal offset follows the scroll position. */
  trackStack?: (el: HTMLElement) => () => void;
}

function PinStack({
  placement,
  members,
  onOpen,
  trackStack,
}: {
  placement: PinPlacement;
  members: PinTarget[];
  onOpen?: PinGutterProps["onOpen"];
  trackStack?: PinGutterProps["trackStack"];
}) {
  const untrack = useRef<(() => void) | null>(null);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      untrack.current?.();
      untrack.current = el && trackStack ? trackStack(el) : null;
    },
    [trackStack],
  );
  const real = members.filter((m) => !m.draft);
  const group = members.length > 1;
  return (
    <div
      ref={ref}
      className="comment-pin-stack"
      data-comment-stack=""
      data-comment-ignore=""
      data-comment-ids={real.map((m) => m.id).join(" ")}
      data-count={group ? members.length : undefined}
      role={group ? "group" : undefined}
      aria-label={group ? `${members.length} comments on this line` : undefined}
      style={{ "--top": `${placement.top}px` } as CSSProperties}
    >
      {members.map((m, i) =>
        m.draft ? (
          <span key={m.id} className="comment-pin comment-pin--draft" aria-hidden="true" style={{ zIndex: members.length - i }}>
            <PinIcon />
          </span>
        ) : (
          <button
            key={m.id}
            type="button"
            className={`comment-pin${m.outdated ? " comment-pin--outdated" : ""}${m.active ? " comment-pin--active" : ""}`}
            data-comment-pin={m.id}
            data-pin={m.pin}
            aria-label={m.label}
            aria-current={m.active ? "true" : undefined}
            style={{ zIndex: members.length - i }}
            onMouseDown={onOpen ? (e) => e.stopPropagation() : undefined}
            onClick={
              onOpen
                ? (e) => {
                    e.stopPropagation();
                    onOpen(m.id, e.currentTarget);
                  }
                : undefined
            }
          >
            <PinIcon />
          </button>
        ),
      )}
    </div>
  );
}

/**
 * The right-gutter pins of one host (a code / diff row, or the markdown container), at the tops the measurer
 * computed. One button per comment showing a comment icon (the number is `data-pin` and the accessible name,
 * never drawn); comments that share a visual line overlap in one stack (a `group` for assistive tech, with a
 * total count badge `data-count` from two). The open box's draft pin is a dashed, `aria-hidden` circle with the
 * icon stroked in `--comment`. Render AFTER the row / container text so the stack never joins the text corpus.
 */
export function PinGutter({ placements, targets, onOpen, trackStack }: PinGutterProps) {
  if (placements.length === 0) return null;
  const byId = new Map(targets.map((t) => [t.id, t]));
  return (
    <>
      {placements.map((p) => {
        const members = p.ids.map((id) => byId.get(id)).filter((m): m is PinTarget => !!m);
        return members.length ? <PinStack key={p.ids.join(" ")} placement={p} members={members} onOpen={onOpen} trackStack={trackStack} /> : null;
      })}
    </>
  );
}
