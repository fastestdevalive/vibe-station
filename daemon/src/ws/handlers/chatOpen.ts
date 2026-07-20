/**
 * JSON agent-chat WS handlers (Decision 6/12, pagination R2.1/R2.3/R2.7).
 *
 * `chat:open` subscribes the connection to a session's normalized event stream
 * and replays a BOUNDED window via `chat:replay` — the last N turns + a
 * `{ oldestSeq, hasMore }` keyset cursor — not the whole transcript. When a
 * `sinceSeq` is supplied (reconnect), it instead replays only the delta of
 * events newer than that cursor. It then bridges the session's `JsonAgentStream`
 * → `session:message` / `session:meta` frames for as long as the chat is open.
 *
 * Read→subscribe gap (R2.7): the live listeners are attached BEFORE the snapshot
 * read below, which is synchronous — so no event emitted between the snapshot and
 * the attach can be lost. Any overlap dedupes by `id`/`logSeq` on the client.
 *
 * `chat:close` detaches those listeners. The session's `JsonAgentStream` lives
 * on the (lazily-created) `JsonAgentSession`, so opening a chat before any turn
 * has run still works — the stream just stays quiet until a turn is enqueued.
 */

import type { WSConnection, ChatStreamEntry } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import {
  findJsonSessionContext,
  resolveJsonAgent,
  readSessionTail,
  readSessionSince,
  type JsonSessionContext,
} from "../../services/jsonAgentChat.js";
import type { NormalizedEvent, SessionMeta } from "../../types.js";

/** Default bounded replay window on open (turns). Open decision #1: N=20. */
const TAIL_TURNS = 20;

export async function handleChatOpen(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "chat:open" }>,
): Promise<void> {
  const { sessionId, sinceSeq } = msg;

  const ctx = findJsonSessionContext(sessionId);
  if (!ctx) {
    conn.send({ type: "session:error", sessionId, message: `Session '${sessionId}' not found` });
    return;
  }

  conn.subscribe([sessionId]);

  // Resolve (lazily create) the JsonAgentSession so we can attach to its stream
  // and read its current meta. No spawn happens here — only on enqueue.
  const resolved = await resolveJsonAgent(sessionId, 0).catch(() => null);

  if (!resolved || !resolved.ok) {
    // Not a JSON session or mode unresolved — no live stream to attach; send a
    // bounded snapshot from disk (tail or since delta) and stop.
    sendSnapshot(conn, ctx, sessionId, sinceSeq);
    return;
  }
  const { agent } = resolved;

  // Attach the live listeners FIRST, then take the snapshot synchronously below
  // (R2.7 read→subscribe gap). Replace any prior subscription for this session.
  conn.unregisterChatStream(sessionId);
  const onMessage = (event: NormalizedEvent): void => {
    conn.send({ type: "session:message", sessionId, event });
  };
  const onMeta = (meta: SessionMeta): void => {
    conn.send({ type: "session:meta", sessionId, meta });
  };
  agent.stream.on("message", onMessage);
  agent.stream.on("meta", onMeta);
  const entry: ChatStreamEntry = { stream: agent.stream, onMessage, onMeta };
  conn.registerChatStream(sessionId, entry);

  // Snapshot AFTER attach — synchronous, so nothing interleaves (R2.7).
  sendSnapshot(conn, ctx, sessionId, sinceSeq);
  conn.send({ type: "session:meta", sessionId, meta: agent.getMeta() });
}

/**
 * Send the bounded `chat:replay`: a `sinceSeq` delta (reconnect) or the tail-N
 * window + `{ oldestSeq, hasMore }` cursor (fresh open). Reads live-or-disk.
 */
function sendSnapshot(
  conn: WSConnection,
  ctx: JsonSessionContext,
  sessionId: string,
  sinceSeq: number | undefined,
): void {
  if (sinceSeq !== undefined) {
    conn.send({ type: "chat:replay", sessionId, events: readSessionSince(ctx, sinceSeq) });
    return;
  }
  const page = readSessionTail(ctx, TAIL_TURNS);
  conn.send({
    type: "chat:replay",
    sessionId,
    events: page.events,
    ...(page.oldestSeq !== undefined ? { oldestSeq: page.oldestSeq } : {}),
    hasMore: page.hasMore,
  });
}

export function handleChatClose(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "chat:close" }>,
): void {
  conn.unregisterChatStream(msg.sessionId);
  conn.unsubscribe([msg.sessionId]);
}
