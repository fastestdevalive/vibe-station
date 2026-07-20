import type { Attachment } from "@/api/types";
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
          <div className="chat-bubble__text">{text}</div>
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
