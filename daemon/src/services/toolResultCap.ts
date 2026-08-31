/**
 * Shared `tool_result` size cap (json-mode-followups item 1, Decision 1).
 *
 * Oversized tool results (base64 images, huge log/grep dumps) must never land
 * raw in the SQLite transcript store or ship unbounded to the browser. This is
 * a plain function (not a method on either class) so it can be called from
 * BOTH independent write paths without a circular import:
 *  - `JsonAgentSession.handleEvent` (live-turn path, `jsonAgent.ts`)
 *  - `SqliteTranscriptStore.importTransaction` (at-rest channel-toggle
 *    backfill path, `sqliteTranscriptStore.ts`) — this does NOT go through
 *    `handleEvent`, so it needs its own call site (Decision 1 rationale).
 */

import type { NormalizedEvent } from "../types.js";

/** Applies regardless of `isError` (Decision 2) — a huge stack trace is still huge. */
export const TOOL_RESULT_MAX_BYTES = 20_000;

/** Mutates `ev` in place, replacing oversized `tool_result.content` with a marker. */
export function capToolResultContent(ev: NormalizedEvent): void {
  if (ev.kind === "tool_result" && ev.toolResult?.content) {
    const size = Buffer.byteLength(ev.toolResult.content, "utf8");
    if (size > TOOL_RESULT_MAX_BYTES) {
      ev.toolResult = { ...ev.toolResult, content: `(tool result omitted — ${size} bytes)` };
    }
  }
  // Structured file-edit diffs (acp-normalize-superset) carry the full
  // before/after file text — same unbounded-size risk as `toolResult.content`
  // above (a large generated file rewrite), so the same cap applies per-diff.
  if (ev.toolDiffs?.length) {
    ev.toolDiffs = ev.toolDiffs.map((diff) => {
      const oldSize = diff.oldText ? Buffer.byteLength(diff.oldText, "utf8") : 0;
      const newSize = Buffer.byteLength(diff.newText, "utf8");
      if (oldSize <= TOOL_RESULT_MAX_BYTES && newSize <= TOOL_RESULT_MAX_BYTES) return diff;
      return {
        path: diff.path,
        oldText: oldSize > TOOL_RESULT_MAX_BYTES ? undefined : diff.oldText,
        newText: newSize > TOOL_RESULT_MAX_BYTES ? `(diff omitted — ${newSize} bytes)` : diff.newText,
      };
    });
  }
}
