import type { Attachment } from "@/api/types";
import { parseSkillSegments } from "@/lib/skillInvocation";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { AttachmentChip } from "./AttachmentChip";

interface TextMessageProps {
  role: "user" | "assistant";
  text: string;
  attachments?: Attachment[];
  /** Greyed-out pending (optimistic/queued) styling for user bubbles. */
  pending?: boolean;
}

/**
 * A user or assistant text message. User messages render as a right-aligned
 * plain-text bubble; assistant messages render GFM markdown (streaming-tolerant,
 * raw-HTML off — Decision 9).
 */
export function TextMessage({ role, text, attachments, pending }: TextMessageProps) {
  const isUser = role === "user";
  return (
    <div
      className={`chat-msg chat-msg--${role}${pending ? " chat-msg--pending" : ""}`}
      data-role={role}
    >
      <div className={`chat-bubble chat-bubble--${role}`}>
        {isUser ? (
          // Phase 7B.10: a sent user message still carries the internal
          // `{/name args}` wire encoding (Decision 2) — never surface it.
          // Tokens render as a styled inline chip so the skill name and its
          // arguments read differently from the surrounding prose. No catalog
          // lookup is involved: a token IS a token, so what is highlighted
          // here can never drift from what the composer produced.
          <div className="chat-bubble__text">
            {parseSkillSegments(text).map((seg, i) =>
              seg.type === "text" ? (
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
          <StreamingMarkdown source={text} />
        )}
        {attachments && attachments.length > 0 ? (
          <div className="chat-bubble__attachments">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
