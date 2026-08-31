/**
 * Pure `session/update` → `NormalizedEvent` mapping (Decision 2/6, Phase 1.3).
 * No state, no I/O — the shared normalizer every ACP-migrated plugin routes
 * through. Per-CLI quirks are handled by an optional `enrich` hook the plugin
 * supplies (Decision 2.3), never by branching on `provider` in here.
 *
 * Introduces NO new NormalizedEventKind — every ACP update kind maps onto the
 * existing set in `daemon/src/types.ts` (Requirement 5).
 */
import { randomUUID } from "node:crypto";
import type { NormalizedEvent, NormalizedEventProvider } from "../../types.js";

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

function textFromContentBlock(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const block = content as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  return undefined;
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
      const text = textFromContentBlock(raw.content);
      if (text === undefined) return null;
      base = stamp({ kind: "text", role: "assistant", text });
      break;
    }
    case "agent_thought_chunk": {
      const text = textFromContentBlock(raw.content);
      if (text === undefined) return null;
      base = stamp({ kind: "thinking", role: "assistant", text });
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
      base = stamp({
        kind: "tool_use",
        role: "assistant",
        toolId: toolCallId,
        toolName: typeof raw.title === "string" ? raw.title : (typeof raw.kind === "string" ? raw.kind : undefined),
        toolInput: raw.rawInput ?? raw.input ?? undefined,
      });
      break;
    }
    case "tool_call_update": {
      const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
      const status = typeof raw.status === "string" ? raw.status : undefined;
      // Only a terminal status (completed/failed) carries a result; an
      // in-progress update has nothing new to render as a NormalizedEvent.
      if (status !== "completed" && status !== "failed") return null;
      const content = Array.isArray(raw.content) ? raw.content : [];
      const text = content
        .map((c) => (c && typeof c === "object" ? textFromContentBlock((c as Record<string, unknown>).content ?? c) : undefined))
        .filter((t): t is string => typeof t === "string")
        .join("\n");
      base = stamp({
        kind: "tool_result",
        toolId: toolCallId,
        toolResult: { content: text || undefined, isError: status === "failed" },
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
