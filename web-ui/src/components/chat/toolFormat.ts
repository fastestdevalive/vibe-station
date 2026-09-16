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

/**
 * Split a (relative) file path into its directory and basename so a tool row
 * can render the basename prominently (bright, leading the header) while the
 * full directory + basename path appears in the expanded body. A bare file
 * name with no directory returns `{ dir: "", name }`.
 */
export function splitPath(path: string): { dir: string; name: string } {
  if (!path) return { dir: "", name: "" };
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/** One item of the agent's todo list, as derived from a todoWrite tool call. */
export interface TodoItem {
  text: string;
  state: "done" | "active" | "pending";
}

/** Claude Code `TodoWrite` / opencode `todoWrite` family of plan tools. */
export function isTodoToolName(name: string | undefined): boolean {
  const lower = (name ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  return lower === "todowrite" || lower === "todo_write" || lower === "todo" || lower === "todolist";
}

/** Parse a markdown checkbox list (`- [x] item`) or a plain JSON string array
 *  out of a tool result's text — the fallback for adapters that only return
 *  the todo list in the result rather than a structured `toolInput`. */
export function parseTodoResult(content: string | undefined): TodoItem[] | undefined {
  if (!content) return undefined;
  // Markdown checkboxes: `- [x] done` / `- [ ] pending` / `- [X] done`.
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s*\[[ xX]\]/.test(l));
  if (lines.length > 0) {
    return lines.map((l) => ({
      text: l.replace(/^[-*]\s*\[[ xX]\]\s*/, "").trim(),
      state: /\[[xX]\]/.test(l) ? ("done" as const) : ("pending" as const),
    }));
  }
  // Plain JSON string array.
  try {
    const trimmed = content.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) {
        const items = arr.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
        if (items.length > 0) return items.map((t) => ({ text: t, state: "pending" as const }));
      }
    }
  } catch {
    /* not JSON — ignore */
  }
  return undefined;
}

/** Map a todo item's status string to our display state. opencode uses
 *  `in_progress` / `completed` / `pending` (or `done`); treat anything
 *  completed-ish as done, in-progress-ish as active, else pending. */
function stateFromStatus(status: unknown): TodoItem["state"] {
  const s = typeof status === "string" ? status.toLowerCase() : "";
  if (s === "completed" || s === "done") return "done";
  if (s === "in_progress" || s === "active") return "active";
  return "pending";
}

/**
 * Derive the agent's todo list from a todoWrite/todoWrite-family tool call.
 * The list arrives in `toolInput.todos`, which for opencode is an array of
 * objects `{ content, status, priority }` (each item carries its own status —
 * the most accurate signal) and for other adapters may be `string[]` plus a
 * single active `todo`. Claude's `TodoWrite` sends just `todo` + `status` and
 * often the list in the result text. Returns `undefined` when the call isn't a
 * todo tool or carries nothing usable. The "last snapshot wins" model relies
 * on opencode re-sending the whole list each time, so the newest snapshot is
 * the current truth.
 */
export function extractTodos(toolName: string | undefined, toolInput: unknown, toolResultContent?: string): TodoItem[] | undefined {
  if (!isTodoToolName(toolName)) return undefined;
  const items: TodoItem[] = [];

  if (toolInput && typeof toolInput === "object") {
    const obj = toolInput as Record<string, unknown>;
    const rawTodos = Array.isArray(obj.todos) ? obj.todos : undefined;
    if (rawTodos && rawTodos.length > 0) {
      // opencode sends objects with per-item status; some adapters send plain
      // strings (then we fall back to position relative to the active `todo`).
      const allStrings = rawTodos.every((t) => typeof t === "string");
      if (allStrings) {
        const strings = rawTodos as string[];
        const activeText = typeof obj.todo === "string" ? obj.todo : undefined;
        const activeIdx = activeText !== undefined ? strings.indexOf(activeText) : -1;
        const allDone = stateFromStatus(obj.status) === "done";
        strings.forEach((s, i) => {
          const t = s.trim();
          if (!t) return;
          let state: TodoItem["state"] = "pending";
          if (allDone) state = "done";
          else if (activeIdx >= 0) {
            if (i < activeIdx) state = "done";
            else if (i === activeIdx) state = "active";
          }
          items.push({ text: t, state });
        });
      } else {
        for (const raw of rawTodos) {
          if (!raw || typeof raw !== "object") continue;
          const o = raw as Record<string, unknown>;
          const text = typeof o.content === "string" ? o.content : typeof o.text === "string" ? o.text : undefined;
          if (!text || !text.trim()) continue;
          items.push({ text: text.trim(), state: stateFromStatus(o.status) });
        }
      }
    } else if (typeof obj.todo === "string" && obj.todo.trim().length > 0) {
      items.push({ text: obj.todo.trim(), state: stateFromStatus(obj.status) });
    }
  }

  if (items.length > 0) return items;

  const fromResult = parseTodoResult(toolResultContent);
  return fromResult && fromResult.length > 0 ? fromResult : undefined;
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
