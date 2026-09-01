/**
 * Claude at-rest history adapter (R0.6/R0.7).
 *
 * Reads `~/.claude/projects/<slug>/<uuid>.jsonl` where `<uuid> == agentChatId`
 * and `<slug>` is the cwd with `/`→`-` and `.`→`-` (same convention as
 * `native-chat-id/claude.ts`). It is a NEW at-rest envelope adapter, NOT a reuse of
 * `parseClaudeStreamLine`:
 *  - the at-rest store is the ONLY source of `user` prompts (the live path
 *    synthesizes those in the core), so we emit `user` events from `type:"user"`
 *    TEXT content here;
 *  - there is no synthetic `result` line at rest, so usage is derived from each
 *    assistant line's `message.usage`.
 *
 * Non-turn envelope lines are skipped: `mode` / `file-history-snapshot` /
 * `ai-title` / `last-prompt` / `queue-operation` / `attachment` / `system`, plus
 * `isMeta` caveats and `isSidechain` subagent turns.
 *
 * Claude inlines image/attachment base64 (confirmed) — every such blob is
 * stripped/externalized on import so raw base64 never enters our store (R0.7).
 *
 * The watermark is a native LINE INDEX: import consumes lines `[watermark, EOF)`
 * and returns the new line count as `nextWatermark` (append-only friendly).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { NormalizedEvent, NormalizedEventKind } from "../types.js";
import type {
  NativeHistoryImporter,
  NativeImportRequest,
  NativeImportResult,
} from "../services/nativeHistoryImporter.js";

/** Non-turn envelope line types skipped wholesale (never carry a real turn). */
const SKIP_TYPES = new Set([
  "system",
  "mode",
  "file-history-snapshot",
  "ai-title",
  "last-prompt",
  "queue-operation",
  "attachment",
]);

/** Tool names whose `tool_use` input can be replayed into a rendered diff. */
const DIFF_TOOL_NAMES = new Set(["Edit", "MultiEdit"]);

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/**
 * Recursively strip inline base64 blobs (`{ source: { type: "base64", data } }`)
 * — claude inlines image/document base64 inside content + tool_result blocks.
 * The blob is replaced by a compact placeholder so the shape survives but the
 * raw base64 never lands in our store (R0.7). claude-native ONLY.
 */
export function stripInlineBase64<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripInlineBase64(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const src = obj.source as Record<string, unknown> | undefined;
    if (src && src.type === "base64" && typeof src.data === "string") {
      const bytes = src.data.length;
      const media = typeof src.media_type === "string" ? src.media_type : "application/octet-stream";
      return {
        ...obj,
        source: { ...src, data: `[base64 ${media} stripped: ${bytes} chars]` },
      } as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = stripInlineBase64(v);
    return out as unknown as T;
  }
  return value;
}

function buildUsage(usageRaw: Record<string, unknown>, model: string): NormalizedEvent["usage"] {
  const inputTokens = num(usageRaw.input_tokens);
  const outputTokens = num(usageRaw.output_tokens);
  const cacheReadTokens = num(usageRaw.cache_read_input_tokens);
  const cacheCreateTokens = num(usageRaw.cache_creation_input_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens,
    model,
  };
}

/**
 * Parse a slice of claude native JSONL lines into NormalizedEvents (R0.6).
 * Exported for the golden test (P2.T1). `startLine` is the watermark line index;
 * `nextLine` is the new EOF line count to persist as the next watermark.
 */
export function parseClaudeNativeHistory(
  lines: string[],
  sessionId: string,
  startLine: number,
): { events: NormalizedEvent[]; nextLine: number } {
  const events: NormalizedEvent[] = [];
  // Turn grouping: a `user` TEXT prompt opens a turn; every following event
  // (assistant blocks, tool results) inherits its `turnId` until the next prompt.
  let currentTurnId: string | undefined;
  // Track tool_use name+input keyed by toolId so tool_result can compute toolDiffs.
  // Imported diffs are fragment-level (the old_string/new_string pair), not whole-file;
  // line numbers restart at 1 within each fragment. Entries are dropped as soon as
  // their tool_result consumes them, so the map stays bounded on a large import.
  const editToolCallById = new Map<string, { name: string; input: Record<string, unknown> }>();

  const mk = (kind: NormalizedEventKind, extra: Partial<NormalizedEvent> & { ts: string }): NormalizedEvent => ({
    id: randomUUID(),
    sessionId,
    provider: "claude",
    kind,
    turnId: currentTurnId,
    ...extra,
  });

  for (let i = Math.max(0, startLine); i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    let d: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") continue;
      d = parsed as Record<string, unknown>;
    } catch {
      continue; // malformed — skip + tolerate
    }

    const type = d.type as string | undefined;
    if (!type || SKIP_TYPES.has(type)) continue;
    if (type !== "user" && type !== "assistant") continue;
    // Skip synthetic caveats + subagent sidechains (not real user turns).
    if (d.isMeta === true || d.isSidechain === true) continue;

    const ts = typeof d.timestamp === "string" ? d.timestamp : new Date().toISOString();
    const msg = (d.message ?? {}) as Record<string, unknown>;
    const content = msg.content;

    if (type === "user") {
      // Is this a real prompt, or a harness-injected one? claude tags every
      // genuine prompt with `origin.kind === "human"` (whatever `promptSource`
      // says — "typed" / "sdk" / "queued" are all real), and tags its own
      // injections (`<task-notification>` replies, etc.) with
      // `promptSource: "system"` and/or a non-human `origin.kind`.
      // NOTE: this gates the PROMPT TEXT only — `tool_result` lines carry no
      // `origin` at all and must still be imported below.
      const originKind = (d.origin as Record<string, unknown> | null | undefined)?.kind;
      const harnessInjected =
        d.promptSource === "system" || (originKind != null && originKind !== "human");

      // A `user` line is EITHER a real prompt (string / text blocks) OR tool
      // RESULTS (tool_result blocks) delivered back to the model.
      if (typeof content === "string") {
        if (harnessInjected) continue;
        currentTurnId = typeof d.uuid === "string" ? d.uuid : randomUUID();
        events.push(mk("user", { role: "user", text: content, ts }));
        continue;
      }
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const toolResults: Record<string, unknown>[] = [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
          else if (block.type === "tool_result") toolResults.push(block);
        }
        if (textParts.length && !harnessInjected) {
          currentTurnId = typeof d.uuid === "string" ? d.uuid : randomUUID();
          // Use only the last text block: multi-block user turns start with a
          // harness-injected system-prompt prefix (turn 1 carries the skill /
          // system prompt as its own block); the real user message is the last.
          events.push(mk("user", { role: "user", text: textParts[textParts.length - 1]!, ts }));
        }
        for (const block of toolResults) {
          const stripped = stripInlineBase64(block.content);
          const contentStr =
            typeof stripped === "string" ? stripped : stripped != null ? JSON.stringify(stripped) : undefined;
          const toolId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
          // Restore toolDiffs for Edit/MultiEdit calls by looking up the corresponding
          // tool_use input. Imported diffs are fragment-level (old_string/new_string pair),
          // not whole-file; line numbers restart at 1 within each fragment.
          let toolDiffs: NormalizedEvent["toolDiffs"] | undefined;
          const call = toolId ? editToolCallById.get(toolId) : undefined;
          if (toolId && call) {
            editToolCallById.delete(toolId); // one result per call — keep the map bounded
            const { name, input } = call;
            if (name === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
              toolDiffs = [{ path: String(input.file_path ?? ""), oldText: input.old_string, newText: input.new_string }];
            } else if (name === "MultiEdit" && Array.isArray(input.edits)) {
              const diffs = (input.edits as unknown[])
                .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
                .filter((e) => typeof e.old_string === "string" && typeof e.new_string === "string")
                .map((e) => ({
                  path: String(e.file_path ?? input.file_path ?? ""),
                  oldText: e.old_string as string,
                  newText: e.new_string as string,
                }));
              if (diffs.length > 0) toolDiffs = diffs;
            }
          }
          events.push(
            mk("tool_result", {
              toolId,
              toolResult: { content: contentStr, isError: block.is_error === true },
              ...(toolDiffs ? { toolDiffs } : {}),
              ts,
            }),
          );
        }
      }
      continue;
    }

    // assistant: text / thinking / tool_use blocks + usage from message.usage.
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          events.push(mk("text", { role: "assistant", text: block.text, ts }));
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          events.push(mk("thinking", { role: "assistant", text: block.thinking, ts }));
        } else if (block.type === "tool_use") {
          const toolId = typeof block.id === "string" ? block.id : undefined;
          const toolInput = stripInlineBase64(block.input);
          const toolName = typeof block.name === "string" ? block.name : undefined;
          // Only edit tools can yield a reconstructed diff — don't retain every
          // other tool's input for the whole import.
          if (toolId && toolName && DIFF_TOOL_NAMES.has(toolName) && toolInput && typeof toolInput === "object") {
            editToolCallById.set(toolId, { name: toolName, input: toolInput as Record<string, unknown> });
          }
          events.push(
            mk("tool_use", {
              role: "assistant",
              toolName,
              toolId,
              toolInput,
              ts,
            }),
          );
        }
      }
    }
    const usageRaw = msg.usage;
    if (usageRaw && typeof usageRaw === "object") {
      const model = typeof msg.model === "string" ? msg.model : "";
      const usage = buildUsage(usageRaw as Record<string, unknown>, model);
      if (usage!.totalTokens > 0) {
        events.push(mk("usage", { usage, ...(model ? { model } : {}), ts }));
      }
    }
  }

  return { events, nextLine: lines.length };
}

/** Absolute path to a claude native store from cwd + agentChatId (uuid). */
export function claudeNativeStorePath(projectsDir: string, cwd: string, agentChatId: string): string {
  const slug = cwd.replaceAll("/", "-").replaceAll(".", "-");
  return join(projectsDir, slug, `${agentChatId}.jsonl`);
}

/** Read the native lines for a store, trimming the always-trailing empty line. */
function readNativeLines(file: string): string[] {
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Construct a claude importer (test seam: override the `~/.claude/projects` dir). */
export function createClaudeHistoryImporter(opts: { projectsDir?: string } = {}): NativeHistoryImporter {
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  return {
    cli: "claude",
    async import(req: NativeImportRequest): Promise<NativeImportResult> {
      const file = claudeNativeStorePath(projectsDir, req.cwd, req.agentChatId);
      const startLine = req.watermark ? Math.max(0, Number.parseInt(req.watermark, 10) || 0) : 0;
      if (!existsSync(file)) {
        return { events: [], nextWatermark: req.watermark ?? "0" };
      }
      const lines = readNativeLines(file);
      const { events, nextLine } = parseClaudeNativeHistory(lines, req.sessionId, startLine);
      return { events, nextWatermark: String(nextLine) };
    },
  };
}

/** Default claude importer (real `~/.claude/projects`). */
export const claudeHistoryImporter: NativeHistoryImporter = createClaudeHistoryImporter();
