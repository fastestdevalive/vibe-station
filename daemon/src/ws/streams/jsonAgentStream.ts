/**
 * EventEmitter adapter bridging a `JsonAgentSession` to WebSocket subscribers.
 *
 * Mirror of `DirectPtyStream` for the JSON channel: the session emits normalized
 * chat events (`message`) and meta updates (`meta`) here, and the `chat:open`
 * WS handler (Part 2) attaches listeners to fan them out as `session:message` /
 * `session:meta` frames. Kept separate from the session so the transport layer
 * (persistence, queue, spawn) never imports `ws`.
 */

import { EventEmitter } from "node:events";
import type { NormalizedEvent, SessionMeta } from "../../types.js";

export interface JsonAgentStreamEvents {
  message: (event: NormalizedEvent) => void;
  meta: (meta: SessionMeta) => void;
}

export class JsonAgentStream extends EventEmitter {
  constructor() {
    super();
    // Many connect/disconnect cycles (one listener pair per WS connection).
    // 0 = no cap; we rely on off() cleanup on detach to avoid real leaks.
    this.setMaxListeners(0);
  }

  emitMessage(event: NormalizedEvent): void {
    this.emit("message", event);
  }

  emitMeta(meta: SessionMeta): void {
    this.emit("meta", meta);
  }
}
