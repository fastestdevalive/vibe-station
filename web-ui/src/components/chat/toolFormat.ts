/**
 * Shared formatting helpers for rendering tool_use / tool_result payloads in
 * chat. Used by the standalone ToolUseCard/ToolResultCard pair (a lone tool
 * call) and by ToolRunSummary's merged per-tool rows (a run of consecutive
 * tool calls) — kept in one place so both stay in sync.
 */

/** One tool_use (+ its tool_result, once it arrives) as rendered in chat —
 *  shared shape between MessageList's `RenderItem` and ToolRunSummary's
 *  per-tool rows so the two don't declare the same type twice. */
export interface ToolCallEntry {
  id: string;
  toolName: string;
  toolInput?: unknown;
  /** Present once the matching tool_result event has arrived. */
  result?: { content?: string; isError?: boolean };
  /** The turn this tool call belongs to — used to stop a run of consecutive
   *  tool calls from merging across a turn boundary. */
  turnId?: string;
}

/** Common single-value tool inputs render inline (command / path / pattern). */
export function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["command", "cmd", "path", "file_path", "filePath", "pattern", "query"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
  }
  return "";
}

export function prettyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
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
export const CLIENT_TOOL_RESULT_MAX_CHARS = 20_000;

export function capForDisplay(text: string): string {
  if (text.length <= CLIENT_TOOL_RESULT_MAX_CHARS) return text;
  return `(tool result omitted — ${text.length} chars)`;
}
