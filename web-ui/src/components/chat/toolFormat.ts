/**
 * Shared formatting helpers for rendering tool_use / tool_result payloads in
 * chat. Used by the standalone ToolUseCard/ToolResultCard pair (a lone tool
 * call) and by ToolRunSummary's merged per-tool rows (a run of consecutive
 * tool calls) — kept in one place so both stay in sync.
 */
import type { AcpToolKind, NormalizedContentBlock, ToolDiff } from "@/api/types";

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
  /** ACP `ToolCallStatus` — when present, drives the spinner/checkmark instead
   *  of `result` truthiness (acp-normalize-superset Decision 4b). */
  status?: "pending" | "in_progress" | "completed" | "failed";
  /** Structured file-edit diffs (acp-normalize-superset Decision 2/3). */
  diffs?: ToolDiff[];
  /** `tool_call`/`tool_call_update.locations` (acp-normalize-superset Gap 3). */
  locations?: { path: string; line?: number }[];
  /** `tool_call`/`tool_call_update.kind`, structural (acp-normalize-superset Gap 4). */
  toolKind?: AcpToolKind;
  /** Native `Task` sub-thread (subagent-ux-v2 Phase 6, Decision 4) — every
   *  tool call bracketed between this Task's own `tool_use` and its
   *  `completed` `tool_result`. Display-only: never used for identity,
   *  navigation, or lifecycle (no payload carries a real parent link). One
   *  level deep only — a Task opening while another is already open closes
   *  the first rather than nesting task-in-task. */
  children?: ToolCallEntry[];
}

/** One-line placeholder for a non-text content block, joined into a bubble's
 *  text when an assistant/thinking event carries `blocks` but no `text`
 *  (acp-normalize-superset Decision 4c) — never a silently blank bubble. */
export function blocksToPlaceholder(blocks: NormalizedContentBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "image":
          return "🖼 image";
        case "audio":
          return "🔊 audio";
        case "resource":
        case "resource_link":
          return `📎 ${b.name ?? b.uri ?? "resource"}`;
        default:
          return b.text ?? "";
      }
    })
    .filter((s) => s.length > 0)
    .join(" ");
}

/** Strip the `cwd` prefix from an absolute path to produce a relative one. */
export function relativize(p: string, cwd?: string): string {
  return cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
}

/** Common single-value tool inputs render inline (command / path / pattern).
 *  `locations` (ACP `tool_call.locations`, acp-normalize-superset Gap 3) is a
 *  fallback for adapters that report a structural edit/read via `locations`
 *  instead of an inspectable `toolInput` — e.g. claude's ACP adapter sends
 *  `toolInput: {}` for Edit/Read, with the actual file path arriving only via
 *  `locations`, so without this fallback those calls show no file name at all. */
export function summarizeToolInput(input: unknown, locations?: { path: string; line?: number }[], cwd?: string): string {
  if (input != null) {
    if (typeof input === "string") return relativize(input, cwd);
    if (typeof input === "object") {
      const obj = input as Record<string, unknown>;
      for (const key of [
        "command",
        "cmd",
        "path",
        "file_path",
        "filePath",
        "TargetFile",
        "targetFile",
        "target_file",
        "pattern",
        "query",
        "description",
        "prompt",
      ]) {
        if (typeof obj[key] === "string") return relativize(obj[key] as string, cwd);
      }
    }
  }
  if (locations && locations.length > 0) {
    return locations.map((l) => (l.line != null ? `${relativize(l.path, cwd)}:${l.line}` : relativize(l.path, cwd))).join(", ");
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

const WRITE_TOOL_NAMES = new Set([
  "write",
  "writefile",
  "write_file",
  "writetofile",
  "write_to_file",
  "create_file",
  "new_file",
]);

export function isWriteToolName(name: string): boolean {
  const lower = name.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return WRITE_TOOL_NAMES.has(lower) || lower.startsWith("write_") || lower.endsWith("_write");
}

export function extractFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "TargetFile", "targetFile", "target_file", "file", "filename"]) {
    if (typeof obj[key] === "string" && (obj[key] as string).trim()) {
      return obj[key] as string;
    }
  }
  return undefined;
}

export function extractFileContent(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ["content", "CodeContent", "codeContent", "code_content", "contents", "text", "file_content", "fileContent"]) {
    if (typeof obj[key] === "string") {
      return obj[key] as string;
    }
  }
  return undefined;
}

/**
 * Extracts structured diffs from a tool call entry. If structured `diffs` are
 * already present on the entry, returns them directly. Otherwise, inspects
 * `toolInput` to reconstruct diffs for edit and write tool calls (e.g. for write
 * file calls or sessions where the backend emitted raw input without diffs).
 */
export function extractToolDiffs(tool: ToolCallEntry): ToolDiff[] | undefined {
  if (tool.diffs && tool.diffs.length > 0) return tool.diffs;

  const input = tool.toolInput;
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;

  const path = extractFilePath(obj) ?? tool.locations?.[0]?.path;

  // Edit / MultiEdit inputs (e.g. if daemon didn't populate tool.diffs)
  if (path && typeof obj.old_string === "string" && typeof obj.new_string === "string") {
    return [{ path, oldText: obj.old_string, newText: obj.new_string }];
  }
  if (path && typeof obj.oldText === "string" && typeof obj.newText === "string") {
    return [{ path, oldText: obj.oldText, newText: obj.newText }];
  }
  if (Array.isArray(obj.edits)) {
    const edits = (obj.edits as unknown[])
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .filter((e) => typeof e.old_string === "string" && typeof e.new_string === "string")
      .map((e) => ({
        path: String(e.file_path ?? e.filePath ?? e.path ?? path ?? ""),
        oldText: e.old_string as string,
        newText: e.new_string as string,
      }))
      .filter((e) => e.path.length > 0);
    if (edits.length > 0) return edits;
  }

  // Write file inputs
  const hasEdit = typeof obj.old_string === "string" || typeof obj.oldText === "string" || Array.isArray(obj.edits);
  const isWrite = isWriteToolName(tool.toolName) || (tool.toolKind === "edit" && !hasEdit);
  const content = extractFileContent(obj);
  if (isWrite && path && typeof content === "string") {
    return [{ path, oldText: "", newText: content }];
  }

  return undefined;
}
