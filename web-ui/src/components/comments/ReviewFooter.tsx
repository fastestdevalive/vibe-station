import { useId, useState } from "react";
import { ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { ReviewCommentSnapshot, ReviewRecord, ReviewSummary } from "@/api/types";
import { Chip } from "@/components/ui/Chip";
import { showInvisibles } from "./visibleText";
import { useWorkspaceStore } from "@/hooks/useStore";
import { plural } from "@/lib/plural";
import { apiErrorText } from "@/lib/apiErrorText";

const noun = plural;

/** `N review comments` + `M files` of a record (the footer's two phrases). */
export function reviewCounts(record: ReviewRecord): { comments: string; files: string } {
  const files = new Set(record.comments.map((c) => c.path)).size;
  return { comments: noun(record.comments.length, "review comment", "review comments"), files: noun(files, "file", "files") };
}

/** `L129` / `L132–136`, or null for a quote-only comment. */
export function lineLabel(c: Pick<ReviewCommentSnapshot, "lines">): string | null {
  if (!c.lines) return null;
  return c.lines.end > c.lines.start ? `L${c.lines.start}–${c.lines.end}` : `L${c.lines.start}`;
}

/** `N restored · M already in the panel` after a Restore to comments. */
export function restoreSummary(restored: number, skipped: number): string {
  return `${restored} restored · ${skipped} already in the panel`;
}

interface ReviewFooterProps {
  record: ReviewRecord;
  /** Comment scope id (worktree, or project for direct sessions): file links open the file in it. */
  scopeId?: string | null;
  /** The sent turn: `Restore to comments` needs both. Absent for imported history (nothing stored to restore). */
  sessionId?: string;
  turnId?: string;
  api?: ApiInstance | null;
  /** Parsed from the message text of imported history (no stored snapshot). */
  parsed?: boolean;
}

/**
 * The chat bubble's review footer (`ChatMessage` board B): a full-bleed button, `N review comments` + muted
 * `M files` + chevron, expanding to file link, lines, quote and text per comment. Every sent card offers
 * `Restore to comments` when expanded (skips pins already in the panel). Cancelled rows get no footer (the
 * caller renders none); an empty-message bubble keeps this as the whole card.
 */
export function ReviewFooter({ record, scopeId, sessionId, turnId, api, parsed }: ReviewFooterProps) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const bodyId = useId();
  const counts = reviewCounts(record);
  const canRestore = !parsed && !!api && !!sessionId && !!turnId;

  async function restore() {
    if (!api || !sessionId || !turnId || busy) return;
    setBusy(true);
    try {
      const res = await api.restoreReview(sessionId, turnId);
      setNote({ text: restoreSummary(res.restored, res.skipped), error: false });
    } catch (e) {
      setNote({ text: apiErrorText(e, "Couldn't restore the comments."), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="comment-footer">
      <button
        type="button"
        className={`comment-footer__bar${open ? " comment-footer__bar--open" : ""}`}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <MessageSquare size={13} className="comment-footer__icon" aria-hidden />
        <span className="comment-footer__count">{counts.comments}</span>
        <span className="comment-footer__muted">{parsed ? "parsed from the message text" : counts.files}</span>
        <span className="comment-footer__spacer" />
        {open ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
      </button>
      {open ? (
        <div id={bodyId} className="comment-footer__body">
          {record.comments.map((c) => (
            <FooterItem key={`${c.id}:${c.pin}`} c={c} scopeId={scopeId ?? null} />
          ))}
          {canRestore ? (
            <div className="comment-footer__restore">
              <button type="button" className="comment-btn" disabled={busy} onClick={() => void restore()}>
                Restore to comments
              </button>
              {note ? (
                <span className={note.error ? "comment-footer__note comment-footer__note--err" : "comment-footer__note"} role="status">
                  {note.text}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FooterItem({ c, scopeId }: { c: ReviewCommentSnapshot; scopeId: string | null }) {
  const line = lineLabel(c);
  const outside = c.pathKind === "artifact" && c.path.startsWith("/");
  const open = () => {
    if (scopeId) useWorkspaceStore.getState().setActiveFilePathAtLine(scopeId, c.path, c.lines?.start ?? 1);
  };
  return (
    <div className="comment-footer__item">
      <div className="comment-footer__file">
        <button type="button" className="comment-footer__link" title={c.path} onClick={open}>
          {c.path}
        </button>
        {line ? <span>{line}</span> : null}
        {outside ? (
          <Chip tone="warn" size="sm">
            outside repo
          </Chip>
        ) : null}
        {c.anchor === "outdated" ? (
          <Chip tone="warn" size="sm">
            outdated
          </Chip>
        ) : null}
        {c.anchor === "file_missing" ? (
          <Chip tone="warn" size="sm">
            file no longer exists
          </Chip>
        ) : null}
      </div>
      {c.quote ? <div className="comment-footer__quote">{showInvisibles(c.quote)}</div> : null}
      <div className="comment-footer__text">{showInvisibles(c.text)}</div>
    </div>
  );
}

/** The queued card's summary line: `N review comments · M files · queued` (not expandable). */
export function QueuedReviewLine({ summary, queued = true }: { summary: ReviewSummary; queued?: boolean }) {
  return (
    <div className="comment-queued-line" data-testid="queued-review-line">
      <MessageSquare size={13} className="comment-footer__icon" aria-hidden />
      <span className="comment-footer__count">{noun(summary.count, "review comment", "review comments")}</span>
      <span className="comment-footer__muted">{noun(summary.files, "file", "files")}</span>
      {queued ? <span className="comment-footer__muted">· queued</span> : null}
    </div>
  );
}
