import { useState } from "react";
import { DiffView } from "@/components/preview/DiffView";
import { capForDisplay, looksLikeUnifiedDiff } from "./toolFormat";

interface ToolResultCardProps {
  toolName?: string;
  content?: string;
  isError?: boolean;
}

// Re-exported for existing callers/tests — canonical implementation now
// lives in toolFormat.ts (shared with ToolRunSummary's merged rows).
export { looksLikeUnifiedDiff };

/**
 * Tool output attached to a tool card. Collapsible; unified diffs render via the
 * shared DiffView (Decision 9), everything else as monospace. Error styling when
 * the tool reported a failure.
 */
export function ToolResultCard({ toolName, content, isError }: ToolResultCardProps) {
  const [open, setOpen] = useState(false);
  const text = capForDisplay(content ?? "");
  const isDiff = !isError && looksLikeUnifiedDiff(text);
  const label = isError ? "Error" : `${toolName ?? "Tool"} result`;

  return (
    <div className={`chat-tool-card chat-tool-card--result${isError ? " chat-tool-card--error" : ""}`}>
      <button
        type="button"
        className="chat-tool-card__header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-tool-card__icon" aria-hidden>{isError ? "⚠" : "✓"}</span>
        <span className="chat-tool-card__name">{label}</span>
        <span className="chat-tool-card__status">
          <span className="chat-tool-card__caret" aria-hidden>{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open ? (
        <div className="chat-tool-card__body">
          {isDiff ? (
            <DiffView diffText={text} />
          ) : (
            <pre className="chat-tool-card__pre">
              <code>{text}</code>
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}
