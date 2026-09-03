/**
 * Pure `session/update` → `NormalizedEvent` mapping (Decision 2/6, Phase 1.3).
 * No state, no I/O — the shared normalizer every ACP-migrated plugin routes
 * through. Per-CLI quirks are handled by an optional `enrich` hook the plugin
 * supplies (Decision 2.3), never by branching on `provider` in here.
 *
 * Introduces only 2 new NormalizedEventKind values (`mode_update`,
 * `commands_update`, acp-normalize-superset Decision 5) — every other ACP
 * update kind still maps onto the pre-existing set in `daemon/src/types.ts`,
 * now carrying additional optional fields instead of dropping data.
 */
import { randomUUID } from "node:crypto";
import type {
  AcpToolKind,
  NormalizedContentBlock,
  NormalizedEvent,
  NormalizedEventProvider,
  ToolDiff,
} from "../../types.js";

/** Raw `session/update` notification payload's `update` field. */
export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

/**
 * Per-plugin enrichment hook (Decision 2.3): given the raw update and the
 * event this module already produced, optionally return a REPLACEMENT event
 * (e.g. mapping a claude-specific `plan` update onto a `status` event with
 * richer text). Return `undefined` to accept the default mapping unchanged.
 */
export type AcpEnrichHook = (
  raw: AcpSessionUpdate,
  base: NormalizedEvent,
) => NormalizedEvent | undefined;

// Gap 1 — single-block mapper for agent_message_chunk/agent_thought_chunk.
// Text-only content is UNCHANGED: `{ text }`, no `blocks` field, matching
// today's normalize.ts:61-63/67-69 exactly.
function toNormalizedBlock(block: unknown): NormalizedContentBlock | undefined {
  if (!block || typeof block !== "object") return undefined;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return typeof b.text === "string" ? { type: "text", text: b.text } : undefined;
    case "image":
    case "audio":
      return typeof b.mimeType === "string" && typeof b.data === "string"
        ? { type: b.type, mimeType: b.mimeType, data: b.data }
        : undefined;
    case "resource_link":
      return typeof b.uri === "string"
        ? { type: "resource_link", uri: b.uri, name: typeof b.name === "string" ? b.name : undefined, mimeType: typeof b.mimeType === "string" ? b.mimeType : undefined }
        : undefined;
    case "resource": {
      const r = b.resource as Record<string, unknown> | undefined;
      return r && typeof r.uri === "string"
        ? { type: "resource", uri: r.uri, mimeType: typeof r.mimeType === "string" ? r.mimeType : undefined }
        : undefined;
    }
    default:
      return undefined;
  }
}

function contentFromChunk(block: unknown): { text?: string; blocks?: NormalizedContentBlock[] } {
  const mapped = toNormalizedBlock(block);
  if (!mapped) return {};
  if (mapped.type === "text") return { text: mapped.text };
  return { blocks: [mapped] };
}

/** Unwrap one `ToolCallContent` array entry: `{type:"content",content}` → the inner `ContentBlock`, else the entry itself. */
function unwrapToolCallContent(entry: unknown): unknown {
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    return e.content ?? entry;
  }
  return entry;
}

/** Extract `{type:"diff"}` entries from a `tool_call`/`tool_call_update.content` array. */
function toolDiffsFromContent(content: unknown): ToolDiff[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const diffs: ToolDiff[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type === "diff" && typeof e.path === "string" && typeof e.newText === "string") {
      diffs.push({
        path: e.path,
        oldText: typeof e.oldText === "string" ? e.oldText : undefined,
        newText: e.newText,
      });
    }
  }
  return diffs.length > 0 ? diffs : undefined;
}

/** Extract text blocks from a `tool_call`/`tool_call_update.content` array (existing behavior). */
function textFromToolCallContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((c) => contentFromChunk(unwrapToolCallContent(c)).text)
    .filter((t): t is string => typeof t === "string")
    .join("\n");
  return text || undefined;
}

/** `tool_call`/`tool_call_update.locations` → `NormalizedEvent.toolLocations` (Gap 3). */
function toolLocationsFrom(raw: unknown): { path: string; line?: number }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const locations: { path: string; line?: number }[] = [];
  for (const l of raw) {
    if (!l || typeof l !== "object") continue;
    const loc = l as Record<string, unknown>;
    if (typeof loc.path === "string") {
      locations.push({ path: loc.path, line: typeof loc.line === "number" ? loc.line : undefined });
    }
  }
  return locations.length > 0 ? locations : undefined;
}

const TOOL_KINDS = new Set<AcpToolKind>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

function toolKindFrom(raw: unknown): AcpToolKind | undefined {
  return typeof raw === "string" && TOOL_KINDS.has(raw as AcpToolKind) ? (raw as AcpToolKind) : undefined;
}

/**
 * Map ONE `session/update` payload into zero-or-one NormalizedEvent. Returns
 * `null` for update kinds this daemon has nothing useful to render (still
 * counts as "handled", not an error).
 */
export function normalizeSessionUpdate(
  raw: AcpSessionUpdate,
  sessionId: string,
  provider: NormalizedEventProvider,
  enrich?: AcpEnrichHook,
): NormalizedEvent | null {
  const stamp = (extra: Partial<NormalizedEvent>): NormalizedEvent => ({
    id: randomUUID(),
    sessionId,
    ts: new Date().toISOString(),
    provider,
    kind: "text",
    ...extra,
  });

  let base: NormalizedEvent | null = null;

  switch (raw.sessionUpdate) {
    case "agent_message_chunk": {
      const { text, blocks } = contentFromChunk(raw.content);
      if (text === undefined && blocks === undefined) return null;
      base = stamp({ kind: "text", role: "assistant", text, blocks });
      break;
    }
    case "agent_thought_chunk": {
      const { text, blocks } = contentFromChunk(raw.content);
      if (text === undefined && blocks === undefined) return null;
      base = stamp({ kind: "thinking", role: "assistant", text, blocks });
      break;
    }
    case "user_message_chunk": {
      // Daemon-owned in the existing model (Decision 12) — the daemon already
      // synthesizes `user` events at enqueue time, so an agent-echoed user
      // chunk is redundant. Skip it rather than double-rendering the message.
      return null;
    }
    case "tool_call": {
      const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
      const status = typeof raw.status === "string" ? raw.status : undefined;
      base = stamp({
        kind: "tool_use",
        role: "assistant",
        toolId: toolCallId,
        toolName: typeof raw.title === "string" ? raw.title : (typeof raw.kind === "string" ? raw.kind : undefined),
        toolInput: raw.rawInput ?? raw.input ?? undefined,
        toolLocations: toolLocationsFrom(raw.locations),
        toolKind: toolKindFrom(raw.kind),
        toolDiffs: toolDiffsFromContent(raw.content),
        toolStatus:
          status === "pending" || status === "in_progress" || status === "completed" || status === "failed"
            ? status
            : undefined,
      });
      break;
    }
    case "tool_call_update": {
      const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
      const status = typeof raw.status === "string" ? raw.status : undefined;
      // Every status (including non-terminal pending/in_progress) now emits an
      // event carrying `toolStatus`; only a terminal status's actual `content`
      // populates `toolResult` — an in-progress update with no content leaves
      // `toolResult` undefined rather than overwriting a previously-set result.
      const text = textFromToolCallContent(raw.content);
      base = stamp({
        kind: "tool_result",
        toolId: toolCallId,
        toolResult: raw.content !== undefined ? { content: text, isError: status === "failed" } : undefined,
        toolStatus:
          status === "pending" || status === "in_progress" || status === "completed" || status === "failed"
            ? status
            : undefined,
        toolDiffs: toolDiffsFromContent(raw.content),
        toolLocations: toolLocationsFrom(raw.locations),
        toolKind: toolKindFrom(raw.kind),
      });
      break;
    }
    case "current_mode_update": {
      base = stamp({
        kind: "mode_update",
        modeId: typeof raw.currentModeId === "string" ? raw.currentModeId : undefined,
      });
      break;
    }
    case "available_commands_update": {
      const availableCommands = Array.isArray(raw.availableCommands) ? raw.availableCommands : [];
      base = stamp({
        kind: "commands_update",
        commands: availableCommands
          .map((c) => {
            if (!c || typeof c !== "object" || typeof (c as Record<string, unknown>).name !== "string") {
              return undefined;
            }
            const rec = c as Record<string, unknown>;
            // ACP's `AvailableCommandInput` (currently only the "unstructured"
            // variant) carries a `hint` string to show as a placeholder before
            // the user has typed arguments — surface it as `argumentHint`
            // rather than dropping it (plan Decision 7 / 2.1).
            const input = rec.input;
            const argumentHint =
              input && typeof input === "object" && typeof (input as Record<string, unknown>).hint === "string"
                ? ((input as Record<string, unknown>).hint as string)
                : undefined;
            // Strip ONE leading "/" here — the single choke point where an
            // ACP command entry is built. Names flow downstream into a
            // catalog of BARE names (skillInvocation.ts's `matchLongestName`
            // prepends its own "/"); leaving it in doubles up everywhere
            // else (popover renders "//plan", selection inserts "//plan ",
            // and the message never dispatches). acpNormalize.test.ts 2.T1
            // feeds "/plan" and asserts the stripped "plan" form.
            const rawName = rec.name as string;
            const name = rawName.startsWith("/") ? rawName.slice(1) : rawName;
            return {
              name,
              description: typeof rec.description === "string" ? (rec.description as string) : "",
              ...(argumentHint !== undefined ? { argumentHint } : {}),
            };
          })
          .filter((c): c is { name: string; description: string; argumentHint?: string } => c !== undefined),
      });
      break;
    }
    case "plan": {
      // A plan update becomes a `status` event, never a new kind (Phase 2.3).
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      const summary = entries
        .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>).content : undefined))
        .filter((c): c is string => typeof c === "string")
        .join("; ");
      base = stamp({ kind: "status", text: summary || "plan updated" });
      break;
    }
    default:
      return null;
  }

  if (!base) return null;
  const enriched = enrich?.(raw, base);
  return enriched ?? base;
}
