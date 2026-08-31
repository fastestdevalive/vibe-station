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
      // A `user` line is EITHER a real prompt (string / text blocks) OR tool
      // RESULTS (tool_result blocks) delivered back to the model.
      if (typeof content === "string") {
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
        if (textParts.length) {
          currentTurnId = typeof d.uuid === "string" ? d.uuid : randomUUID();
          events.push(mk("user", { role: "user", text: textParts.join("\n"), ts }));
        }
        for (const block of toolResults) {
          const stripped = stripInlineBase64(block.content);
          const contentStr =
            typeof stripped === "string" ? stripped : stripped != null ? JSON.stringify(stripped) : undefined;
          events.push(
            mk("tool_result", {
              toolId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
              toolResult: { content: contentStr, isError: block.is_error === true },
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
          events.push(
            mk("tool_use", {
              role: "assistant",
              toolName: typeof block.name === "string" ? block.name : undefined,
              toolId: typeof block.id === "string" ? block.id : undefined,
              toolInput: stripInlineBase64(block.input),
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
