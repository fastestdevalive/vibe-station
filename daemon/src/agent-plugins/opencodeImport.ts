/**
 * OpenCode at-rest history adapter (R0.6).
 *
 * Reads the single global SQLite store `~/.local/share/opencode/opencode.db`
 * (`session` / `message` / `part` tables, JSON in each `data` column). Filters to
 * one `session.id == agentChatId`. It is a NEW at-rest envelope adapter, NOT a
 * reuse of `parseOpencodeStreamLine`:
 *  - `user` events are SYNTHESIZED from the user message's `text` `part` rows
 *    (the live path never persists a user echo);
 *  - assistant `text`/`reasoning`/`tool` parts map to `text`/`thinking`/
 *    `tool_use`+`tool_result`, and usage is derived from the assistant message's
 *    `data.tokens`.
 *
 * The DB is opened READONLY so importing never contends with a live opencode
 * process writing to the shared global store.
 *
 * The watermark is the `message.time_created` (ms epoch) of the last imported
 * message; import reads messages with `time_created > watermark`.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import type { NormalizedEvent, NormalizedEventKind } from "../types.js";
import type {
  NativeHistoryImporter,
  NativeImportRequest,
  NativeImportResult,
} from "../services/nativeHistoryImporter.js";

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

function buildUsage(tokens: Record<string, unknown>, model: string): NormalizedEvent["usage"] {
  const cache = (tokens.cache ?? {}) as Record<string, unknown>;
  const inputTokens = num(tokens.input);
  const outputTokens = num(tokens.output);
  const cacheReadTokens = num(cache.read);
  const cacheCreateTokens = num(cache.write);
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
 * Import one opencode session's at-rest turns from an OPEN better-sqlite3 handle
 * (R0.6). Exported for the golden test (P2.T2). Returns the events + the next
 * watermark (max `message.time_created` seen, as a string).
 */
export function importOpencodeHistory(
  db: DB,
  sessionId: string,
  agentChatId: string,
  watermark?: string,
): { events: NormalizedEvent[]; nextWatermark: string } {
  const since = watermark != null && watermark !== "" ? Number(watermark) : -1;
  const messages = db
    .prepare(
      "SELECT id, data, time_created AS t FROM message WHERE session_id = ? AND time_created > ? ORDER BY time_created ASC, id ASC",
    )
    .all(agentChatId, since) as { id: string; data: string; t: number }[];
  const partStmt = db.prepare(
    "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC",
  );

  const events: NormalizedEvent[] = [];
  // Turn grouping: a `user` message opens a turn; the assistant message(s) that
  // follow inherit its id as `turnId` until the next user message.
  let currentTurnId: string | undefined;
  let maxT = since;

  const mk = (kind: NormalizedEventKind, extra: Partial<NormalizedEvent> & { ts: string }): NormalizedEvent => ({
    id: randomUUID(),
    sessionId,
    provider: "opencode",
    kind,
    turnId: currentTurnId,
    ...extra,
  });

  for (const m of messages) {
    if (m.t > maxT) maxT = m.t;
    let md: Record<string, unknown>;
    try {
      md = JSON.parse(m.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role = md.role as string | undefined;
    const created = (md.time as { created?: number } | undefined)?.created;
    const ts = typeof created === "number" ? new Date(created).toISOString() : new Date().toISOString();
    const parts = (partStmt.all(m.id) as { data: string }[])
      .map((p) => {
        try {
          return JSON.parse(p.data) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((p): p is Record<string, unknown> => p != null);

    if (role === "user") {
      currentTurnId = m.id;
      const texts = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string);
      // Synthesize the user event from the message's text part rows (R0.6).
      events.push(mk("user", { role: "user", text: texts.join("\n"), ts }));
      continue;
    }

    if (role === "assistant") {
      for (const p of parts) {
        const partType = p.type as string | undefined;
        if (partType === "text" && typeof p.text === "string") {
          events.push(mk("text", { role: "assistant", text: p.text, ts }));
        } else if (partType === "reasoning" && typeof p.text === "string") {
          events.push(mk("thinking", { role: "assistant", text: p.text, ts }));
        } else if (partType === "tool") {
          const st = (p.state ?? {}) as Record<string, unknown>;
          const status = st.status as string | undefined;
          const callId = typeof p.callID === "string" ? p.callID : undefined;
          const toolName = typeof p.tool === "string" ? p.tool : undefined;
          events.push(
            mk("tool_use", {
              role: "assistant",
              ...(toolName ? { toolName } : {}),
              ...(callId ? { toolId: callId } : {}),
              toolInput: st.input,
              ts,
            }),
          );
          if (status === "completed" || status === "error") {
            const raw = st.output ?? st.error;
            const contentStr =
              typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : undefined;
            events.push(
              mk("tool_result", {
                ...(callId ? { toolId: callId } : {}),
                toolResult: {
                  ...(contentStr !== undefined ? { content: contentStr } : {}),
                  isError: status === "error",
                },
                ts,
              }),
            );
          }
        }
      }
      const tokens = md.tokens;
      if (tokens && typeof tokens === "object") {
        const model = typeof md.modelID === "string" ? md.modelID : "";
        const usage = buildUsage(tokens as Record<string, unknown>, model);
        if (usage!.totalTokens > 0) {
          events.push(mk("usage", { usage, ...(model ? { model } : {}), ts }));
        }
      }
    }
  }

  const nextWatermark = messages.length ? String(maxT) : (watermark ?? "");
  return { events, nextWatermark };
}

/** Default global opencode store path. */
export function opencodeNativeStorePath(): string {
  return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

/** Construct an opencode importer (test seam: override the DB path). */
export function createOpencodeHistoryImporter(opts: { dbPath?: string } = {}): NativeHistoryImporter {
  const dbPath = opts.dbPath ?? opencodeNativeStorePath();
  return {
    cli: "opencode",
    async import(req: NativeImportRequest): Promise<NativeImportResult> {
      if (!existsSync(dbPath)) {
        return { events: [], nextWatermark: req.watermark ?? "" };
      }
      // Readonly: never contend with a live opencode writing the global store.
      const db = new Database(dbPath, { readonly: true });
      try {
        const r = importOpencodeHistory(db, req.sessionId, req.agentChatId, req.watermark);
        return { events: r.events, nextWatermark: r.nextWatermark || (req.watermark ?? "") };
      } finally {
        db.close();
      }
    },
  };
}

/** Default opencode importer (real global store). */
export const opencodeHistoryImporter: NativeHistoryImporter = createOpencodeHistoryImporter();
