import { useState } from "react";

interface ToolUseCardProps {
  toolName: string;
  toolInput?: unknown;
  /** True while the matching tool_result hasn't arrived yet (shows a spinner). */
  running?: boolean;
}

function summarize(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // Common single-value tool inputs render inline (command / path / pattern).
    for (const key of ["command", "cmd", "path", "file_path", "filePath", "pattern", "query"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
  }
  return "";
}

/** A tool invocation: name + input (collapsible pretty JSON) + running spinner. */
export function ToolUseCard({ toolName, toolInput, running }: ToolUseCardProps) {
  const [open, setOpen] = useState(false);
  const inline = summarize(toolInput);
  const pretty = (() => {
    try {
      return JSON.stringify(toolInput, null, 2);
    } catch {
      return String(toolInput);
    }
  })();
  const hasBody = toolInput != null && pretty !== "undefined";

  return (
    <div className="chat-tool-card chat-tool-card--use">
      <button
        type="button"
        className="chat-tool-card__header"
        aria-expanded={open}
        onClick={() => hasBody && setOpen((v) => !v)}
      >
        <span className="chat-tool-card__icon" aria-hidden>🔧</span>
        <span className="chat-tool-card__name">{toolName}</span>
        {inline ? <code className="chat-tool-card__inline">{inline}</code> : null}
        <span className="chat-tool-card__status">
          {running ? <span className="chat-spinner" aria-label="running" /> : null}
          {hasBody ? <span className="chat-tool-card__caret" aria-hidden>{open ? "▾" : "▸"}</span> : null}
        </span>
      </button>
      {open && hasBody ? (
        <pre className="chat-tool-card__body">
          <code>{pretty}</code>
        </pre>
      ) : null}
    </div>
  );
}
