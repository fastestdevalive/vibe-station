import { memo, useState } from "react";
import { Clock } from "lucide-react";
import type { Attachment } from "@/api/types";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { parseDraftSegments } from "@/lib/mentions";
import { MentionChipView } from "@/components/mentions/MentionChipView";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { AttachmentChip } from "./AttachmentChip";

interface TextMessageProps {
  role: "user" | "assistant";
  text: string;
  attachments?: Attachment[];
  /** Greyed-out pending (optimistic/queued) styling for user bubbles. */
  pending?: boolean;
  /** Optional repo-image resolution context, forwarded to markdown. */
  api?: ApiInstance | null;
  worktreeId?: string | null;
  scope?: FileScope;
  /** This user message was delivered by a scheduled send — tag it inside the bubble. */
  scheduled?: boolean;
  /** Row key from MessageList; keeps html card UI state across virtualized remounts. */
  rowKey?: string;
  /** ISO timestamp of the message; clicking the bubble toggles showing it. */
  ts?: string;
}

/** "14:32" for today, "Oct 22, 14:32" otherwise (seconds in the tooltip). */
function formatSentTime(ts: string): { label: string; full: string } | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const label = sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
  return { label, full: d.toLocaleString() };
}

/**
 * A user or assistant text message. User messages render as a right-aligned
 * plain-text bubble; assistant messages render GFM markdown (streaming-tolerant,
 * raw-HTML off — Decision 9).
 */
export const TextMessage = memo(function TextMessage({ role, text, attachments, pending, api, worktreeId, scope, scheduled, rowKey, ts }: TextMessageProps) {
  const isUser = role === "user";
  const [showTime, setShowTime] = useState(false);
  const sent = ts ? formatSentTime(ts) : null;
  const onBubbleClick = (e: React.MouseEvent) => {
    if (!sent) return;
    // Don't toggle when the click was a text selection or hit a link/button.
    if (window.getSelection()?.toString()) return;
    // Portal clicks (e.g. the image zoom overlay) bubble through React but are
    // not DOM descendants of the bubble.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if ((e.target as HTMLElement).closest("a, button, summary, input, textarea, img, [role=button]")) return;
    setShowTime((v) => !v);
  };
  return (
    <div
      className={`chat-msg chat-msg--${role}${pending ? " chat-msg--pending" : ""}`}
      data-role={role}
    >
      <div className={`chat-bubble chat-bubble--${role}${sent ? " chat-bubble--clickable" : ""}`} onClick={onBubbleClick}>
        {isUser ? (
          // Phase 7B.10: a sent user message still carries the internal
          // `{/name args}` wire encoding (Decision 2) — never surface it.
          // Tokens render as a styled inline chip so the skill name and its
          // arguments read differently from the surrounding prose. No catalog
          // lookup is involved: a token IS a token, so what is highlighted
          // here can never drift from what the composer produced.
          <div className="chat-bubble__text">
            {parseDraftSegments(text).map((seg, i) =>
              seg.type === "mention" ? (
                <MentionChipView key={i} mention={seg.mention} />
              ) : seg.type === "text" ? (
                <span key={i}>{seg.text}</span>
              ) : (
                <span key={i} className="chat-msg-skill">
                  <span className="chat-msg-skill__name">/{seg.name}</span>
                  {seg.args.length > 0 ? (
                    <>
                      {/* A REAL space, not a CSS gap: an inline-flex container
                          drops whitespace-only nodes, so copying the bubble
                          would yield "/code-reviewhigh --fix". */}
                      {" "}
                      <span className="chat-msg-skill__args">{seg.args}</span>
                    </>
                  ) : null}
                </span>
              ),
            )}
          </div>
        ) : (
          <StreamingMarkdown source={text} api={api} worktreeId={worktreeId} scope={scope} renderHtml rowKey={rowKey} />
        )}
        {attachments && attachments.length > 0 ? (
          <div className="chat-bubble__attachments">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} />
            ))}
          </div>
        ) : null}
        {isUser && scheduled ? (
          <div className="chat-bubble__scheduled" title="This message was sent via schedule">
            <Clock size={11} aria-hidden />
            Scheduled
          </div>
        ) : null}
      </div>
      {sent && showTime ? (
        // Overlay, not inline: sibling of the bubble (which clips overflow) and
        // absolutely positioned under it, so toggling it never reflows the
        // message the user may be mid-selection in.
        <div className="chat-bubble__time" title={sent.full}>
          {sent.label}
        </div>
      ) : null}
    </div>
  );
});
