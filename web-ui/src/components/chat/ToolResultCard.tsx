import { useState } from "react";
import { DiffView } from "@/components/preview/DiffView";

interface ToolResultCardProps {
  toolName?: string;
  content?: string;
  isError?: boolean;
}

/** Heuristic: does this look like a unified diff (edit-tool output)? */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (!text) return false;
  if (/^diff --git /m.test(text)) return true;
  // A hunk header plus at least one +/- line is a strong signal.
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text) && /^[+-]/m.test(text);
}

/**
 * Client-side mirror of the server's `TOOL_RESULT_MAX_BYTES` cap
 * (`daemon/src/services/toolResultCap.ts`). Defense-in-depth only — the
 * server caps both write paths (live turns + at-rest import backfill), so
 * this guard mainly protects against a stale cached transcript fetched
 * before the one-time backfill migration ran.
 */
const CLIENT_TOOL_RESULT_MAX_CHARS = 20_000;

function capForDisplay(text: string): string {
  if (text.length <= CLIENT_TOOL_RESULT_MAX_CHARS) return text;
  return `(tool result omitted — ${text.length} chars)`;
}

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
