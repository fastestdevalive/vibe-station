import { useState } from "react";
import { StreamingMarkdown } from "./StreamingMarkdown";

interface ThinkingBlockProps {
  text: string;
  /** Collapsed by default; expands on click. */
  defaultOpen?: boolean;
}

/** Collapsible dim "Thinking…" reasoning block (Decision 9). */
export function ThinkingBlock({ text, defaultOpen = false }: ThinkingBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
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
