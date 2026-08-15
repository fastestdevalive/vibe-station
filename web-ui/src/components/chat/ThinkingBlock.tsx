import { useState } from "react";
import { StreamingMarkdown } from "./StreamingMarkdown";

interface ThinkingBlockProps {
  text: string;
  /** Collapsed by default; expands on click. */
  defaultOpen?: boolean;
}

/** Collapsible dim "Thinking…" reasoning block (Decision 9). Signature-only /
 *  redacted thinking events carry no text — those render as a plain label with
 *  no chevron, since there's nothing to expand. */
export function ThinkingBlock({ text, defaultOpen = false }: ThinkingBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hasContent = text.trim().length > 0;
  if (!hasContent) {
    return (
      <div className="chat-thinking">
        <span className="chat-thinking__toggle chat-thinking__toggle--static">
          <span className="chat-thinking__label">Thinking…</span>
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
        <span className="chat-thinking__label">Thinking…</span>
      </button>
      {open ? (
        <div className="chat-thinking__body">
          <StreamingMarkdown source={text} />
        </div>
      ) : null}
    </div>
  );
}
