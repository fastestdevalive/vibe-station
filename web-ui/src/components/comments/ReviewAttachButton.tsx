import { MessageSquare, X } from "lucide-react";
import type { ComposerReview } from "./useComposerReview";

const noun = (n: number) => (n === 1 ? "comment" : "comments");

/** Accessible name per state (`Attach` board A-D): attach N / N attached, press to detach / attach the N new ones. */
export function attachButtonLabel(review: Pick<ComposerReview, "total" | "attached" | "other">): string {
  const a = review.attached.length;
  if (a === 0) return `Attach ${review.total} ${noun(review.total)}`;
  if (review.other === 0) return `${a} ${noun(a)} attached, press to detach`;
  return `Attach ${review.other} more ${noun(review.other)}`;
}

/**
 * The composer's own Attach button (R131-R134), first item of the editor's top-right cluster. Hidden when the
 * panel is empty. Plain `Attach` attaches everything (moving it from any other composer); once attached it
 * reads `Attached ✓` and pressing it detaches; comments added since show `+N` and a press attaches them all.
 * The label hides at narrow composer widths (container query), leaving icon and count.
 */
export function ReviewAttachButton({ review, blockedReason }: { review: ComposerReview; blockedReason?: string }) {
  const a = review.attached.length;
  if (review.total === 0 && a === 0) return null;
  const plainAttached = a > 0 && review.other === 0;
  const count = a > 0 ? a : review.total;
  const title = blockedReason && a === 0
    ? blockedReason
    : !review.online
    ? "Attach needs the daemon connection"
    : plainAttached
      ? "Detach comments from this message"
      : a > 0
        ? `Attach ${review.other} more ${noun(review.other)} to this message`
        : `Attach all ${review.total} ${noun(review.total)} to this message`;
  return (
    <button
      type="button"
      className={`comment-attach${plainAttached ? " comment-attach--on" : ""}`}
      aria-label={attachButtonLabel(review)}
      {...(plainAttached ? { "aria-pressed": true } : a === 0 ? { "aria-pressed": false } : {})}
      title={title}
      disabled={!review.online || review.busy || (!!blockedReason && a === 0)}
      onClick={() => void review.toggle()}
    >
      <MessageSquare size={12} className="comment-attach__icon" aria-hidden />
      <span className="comment-attach__n">{count}</span>
      {a > 0 && review.other > 0 ? <span className="comment-attach__plus">+{review.other}</span> : null}
      <span className="comment-attach__label">{plainAttached ? "Attached ✓" : "Attach"}</span>
    </button>
  );
}

/** The composer chip: `N comments attached · Detach ✕`. Rendered in the shell's chips row (`extraChips`). */
export function ReviewChip({ review }: { review: ComposerReview }) {
  const a = review.attached.length;
  if (a === 0) return null;
  return (
    <span className="comment-chip" data-testid="review-chip">
      <MessageSquare size={12} className="comment-attach__icon" aria-hidden />
      <span>{`${a} ${noun(a)} attached`}</span>
      <button
        type="button"
        className="comment-chip__detach"
        aria-label={`Detach ${a} ${noun(a)}`}
        disabled={review.busy}
        onClick={() => void review.detach()}
      >
        <span className="comment-chip__sep" aria-hidden>
          ·
        </span>
        Detach
        <X size={10} aria-hidden />
      </button>
    </span>
  );
}
