import { MessageSquare } from "lucide-react";
import { useIsTouch } from "@/hooks/useIsTouch";
import { useCommentSurface } from "./CommentSurfaceContext";
import { useSelectionAnchor } from "./SelectionPopover";
import type { CommentSurfaceValue } from "./CommentSurfaceContext";

/** `Comment` in the preview strip's tail slot, plus the toolbar hint while the file has no comments. */
export function CommentStripButton({ disabledReason }: { disabledReason?: string | null }) {
  const cs = useCommentSurface();
  if (!cs) {
    return disabledReason ? (
      <button type="button" className="comment-btn comment-btn--strip" disabled title={disabledReason} aria-label="Comment">
        <MessageSquare size={14} aria-hidden /> <span className="comment-btn__label">Comment</span>
      </button>
    ) : null;
  }
  return <Enabled cs={cs} />;
}

function Enabled({ cs }: { cs: CommentSurfaceValue }) {
  const sel = useSelectionAnchor(cs, cs.rootEl);
  const touch = useIsTouch();
  const title = sel ? (touch ? "Comment on the selection" : "Comment on the selection (C)") : touch ? "Select text first" : "Select text, then press C";
  return (
    <>
      {cs.all.length === 0 && !touch ? (
        <span className="comment-hint">
          Select text and press <kbd className="comment-kbd">C</kbd>, or click <b className="comment-hint__plus">+</b> in the gutter
        </span>
      ) : null}
      <button
        type="button"
        className="comment-btn comment-btn--strip"
        disabled={!sel}
        title={title}
        aria-label="Comment"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!sel) return;
          cs.openNew(sel.anchor, { anchorEl: sel.endEl });
          sel.dismiss();
        }}
      >
        <MessageSquare size={14} aria-hidden /> <span className="comment-btn__label">Comment</span>
      </button>
    </>
  );
}
