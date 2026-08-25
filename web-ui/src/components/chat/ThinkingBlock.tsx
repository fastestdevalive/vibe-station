import { useState } from "react";
import { StreamingMarkdown } from "./StreamingMarkdown";

interface ThinkingBlockProps {
  text: string;
  /** Collapsed by default; expands on click. */
  defaultOpen?: boolean;
  /** `ts` of the first event in this thinking group (always present —
   *  `groupEvents` stamps it when the group opens). */
  startedTs: string;
  /** `ts` of the event that closed this group (a `text` reply, a turn-end
   *  meta event, or the first event of the next turn); unset while the
   *  block is still live. */
  endedTs?: string;
}

/** "Thought for Xs" once `endedTs` is set, else the live "Thinking" label —
 *  the only place elapsed time renders (Decision 4). Rounds to the nearest
 *  second; a sub-second span still reads "Thought for 0s" rather than being
 *  suppressed, so a very quick thinking burst doesn't look unresolved.
 *
 *  No trailing "…" on the live label, matching `turnLabel`'s busy strings —
 *  the "in progress" continuation is carried by the trailing
 *  `WorkingIndicator`'s animated dots. In practice `MessageList` no longer
 *  renders a still-open thinking group at all, so the live label only
 *  surfaces via the malformed-timestamp fallback below. */
function thinkingLabel(startedTs: string, endedTs: string | undefined): string {
  if (!endedTs) return "Thinking";
  const seconds = Math.round((Date.parse(endedTs) - Date.parse(startedTs)) / 1000);
  // Either timestamp can be empty/malformed (e.g. test fixtures, or a
  // historical event predating this field) — `Date.parse` on an empty string
  // is NaN, which would otherwise render "Thought for NaNs". Fall back to the
  // live label rather than showing a broken duration.
  if (!Number.isFinite(seconds)) return "Thinking";
  return `Thought for ${seconds}s`;
}

/** Collapsible dim "Thinking" / "Thought for Xs" reasoning block (Decision 9,
 *  extended by Decision 4). Signature-only / redacted thinking events carry no
 *  text — those render as a plain label with no chevron, since there's
 *  nothing to expand. */
export function ThinkingBlock({ text, defaultOpen = false, startedTs, endedTs }: ThinkingBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hasContent = text.trim().length > 0;
  const label = thinkingLabel(startedTs, endedTs);
  if (!hasContent) {
    return (
      <div className="chat-thinking">
        <span className="chat-thinking__toggle chat-thinking__toggle--static">
          <span className="chat-thinking__label">{label}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="chat-thinking">
      <button
        type="button"
        className="chat-thinking__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-thinking__caret" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="chat-thinking__label">{label}</span>
      </button>
      {/* No second footer-row copy of `label` below the body: the toggle row
       *  above already reads "Thought for Xs" once ended, and repeating the
       *  identical string ~3 lines apart inside one card is exactly the
       *  redundancy this pass removed elsewhere (the StatusBar busy label).
       *  Plan Decision 4 offered the footer row OR the toggle-label swap as
       *  alternatives — the toggle-label swap is implemented, so the footer
       *  row is redundant, not additive. */}
      {open ? (
        <div className="chat-thinking__body">
          <StreamingMarkdown source={text} />
        </div>
      ) : null}
    </div>
  );
}
