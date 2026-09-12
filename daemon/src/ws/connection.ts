import type { WebSocket } from "@fastify/websocket";
import type { ServerMessage } from "./protocol.js";
import type { SessionStream } from "./streams/sessionStream.js";
import type { JsonAgentStream } from "./streams/jsonAgentStream.js";
import type { NormalizedEvent, SessionMeta, TokenScope } from "../types.js";

/**
 * REGRESSION — remote socket cycling (see branch `fix/ws-socket-cycling`).
 *
 * `send()` used to hard-close the socket with code 1009 once `bufferedAmount`
 * exceeded 1MB. On loopback that never fired, but over any real network (LAN /
 * Tailscale / tunnel) the reconnect replay burst queues past 1MB instantly.
 * The client then reconnected, `onopen` replayed the SAME oversized
 * `chat:replay` + terminal scrollback burst, and the socket was killed again
 * at the same byte count — a deterministic connect/disconnect cycle with no
 * escape (the daemon log shows millions of identical
 * "[WS] Write buffer exceeded 1MB, closing connection" lines in unbroken runs).
 *
 * The fix (three cooperating changes):
 *  1. `send()` never closes on ordinary pressure. It coalesces lossy
 *     `session:output` frames (terminal scrollback, which tmux redraws anyway)
 *     when the buffer is high, and only hard-closes at the real shared
 *     `HARD_LIMIT` (50MB) — see `WS_HARD_LIMIT` and `ws/server.ts`.
 *  2. `chat:replay` deltas are bounded + paginated (LIMIT in
 *     `sqliteTranscriptStore.since()`) so a single frame can never exceed the
 *     limit in the first place.
 *  3. The client advances its `sinceSeq` cursor on `chat:replay` (not just live
 *     `session:message`) so a partially-delivered replay is never re-requested
 *     identically, and resets its reconnect backoff only after the connection
 *     has been stable.
 */

/** Soft backpressure threshold: above this we begin coalescing lossy
 *  `session:output` frames rather than queueing an unbounded scrollback. */
export const WS_SOFT_LIMIT = 1_000_000;
/** Hard limit: above this the connection is beyond hope — close it. Shared
 *  with `ws/server.ts`'s periodic backpressure check so the two agree. */
export const WS_HARD_LIMIT = 50 * 1024 * 1024;

/**
 * A live JSON chat subscription: listeners attached to a session's
 * `JsonAgentStream` for `chat:open`, so `chat:close`/cleanup can detach them
 * without leaking (mirrors the tmux/direct `OpenStreamEntry` pattern).
 */
export type ChatStreamEntry = {
  stream: JsonAgentStream;
  onMessage: (event: NormalizedEvent) => void;
  onMeta: (meta: SessionMeta) => void;
};

export type OpenStreamEntry = {
  kind: "tmux" | "direct";
  stream: SessionStream;
  subscriberId: string;
  /**
   * Chunk listener attached at session:open time. Captured here so session:close
   * can `stream.off("chunk", onChunk)` — for shared (direct-pty) streams this is
   * essential, otherwise a re-open on the same connection accumulates listeners
   * and chunks get delivered to conn.send N times.
   */
  onChunk: (chunk: string) => void;
};

/**
 * Per-connection state holder.
 * Manages subscriptions, open streams, and watchers for a single WS connection.
 */
export class WSConnection {
  private subscriptions: Set<string> = new Set();
  openStreams: Map<string, OpenStreamEntry> = new Map(); // sessionId -> OpenStreamEntry (public for handlers)
  chatStreams: Map<string, ChatStreamEntry> = new Map(); // sessionId -> ChatStreamEntry (JSON chat)
  // key -> { watcher, refCount }. refCount tracks how many independent
  // consumers (e.g. FileTreeSidebar + Quick Open) share the one underlying
  // watcher for this key, so one consumer's unwatch doesn't kill another's
  // (see Decision 8, `.vibekit/feature-plans/pending/ui-improvements/`).
  fileWatches: Map<string, { watcher: unknown; refCount: number }> = new Map(); // public for handlers
  treeWatches: Map<string, { watcher: unknown; refCount: number }> = new Map(); // public for handlers
  // key -> number of stale `release*Watcher` calls still owed from a watcher
  // instance that was force-removed (via `unregister*Watcher`, the error
  // path) while other retainers still held a reference to it. A retainer
  // that hasn't yet learned its watcher died will eventually call
  // `tree:unwatch`/`file:unwatch` anyway; without this ledger that call
  // would decrement whatever NEW entry has since been registered under the
  // same key (by an unrelated consumer), potentially closing a live watcher
  // that has nothing to do with the dead one. `release*Watcher` drains this
  // debt first and no-ops instead of touching the current live entry.
  private fileWatchDebt: Map<string, number> = new Map();
  private treeWatchDebt: Map<string, number> = new Map();
  readonly id: string; // Unique identifier for this connection
  readonly connectedAt: number; // Unix ms — when this connection was established
  lastSeenAt: number; // Unix ms — updated on every incoming message
  private sessionLocks: Map<string, Promise<void>> = new Map(); // sessionId -> tail of promise chain
  /**
   * Diagnostic flag (mobile double-text investigation). Set once a client sends
   * a `debug:log` message — the client only does so when input debugging is
   * enabled (?debugInput=1). When true, this connection's `session:input` bytes
   * are also written to the input-debug log so we have ground truth of what the
   * daemon actually received vs. what the client thought it sent.
   */
  debugInput = false;
  /** Set at auth time so revoke can close connections by scope. null = noAuth or CLI Bearer. */
  scope: TokenScope | null = null;
  /** payloadB64 portion of the token — unique per mint. null for loopback/noAuth. */
  tokenId: string | null = null;
  /** payload.iat — when the token was minted. null for loopback/noAuth. */
  tokenIssuedAt: number | null = null;
  /** payload.exp — token expiry (browser tokens only). null otherwise. */
  tokenExpiresAt: number | null = null;

  constructor(private ws: WebSocket) {
    this.id = Math.random().toString(36).slice(2);
    this.connectedAt = Date.now();
    this.lastSeenAt = this.connectedAt;
  }

  get socket(): WebSocket {
    return this.ws;
  }

  /** Pending coalesced terminal output per session (session:output only), sent
   *  as a single chunk on the next send once the buffer has drained. */
  private coalescedOutput = new Map<string, string>();
  private coalesceFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Send a message to the client, handling backpressure WITHOUT killing the
   * socket on ordinary write-buffer pressure (see the file-header regression
   * note — this is the primary fix for the remote socket-cycling bug).
   *
   * Behaviour:
   *  - Under `WS_SOFT_LIMIT` (1MB): send normally.
   *  - Over `WS_SOFT_LIMIT` but under `WS_HARD_LIMIT` (50MB): coalesce lossy
   *    `session:output` frames into a single chunk per session, and flush once
   *    the buffer drains. Terminal scrollback is lossy-tolerant — tmux redraws
   *    on resize/input — so dropping/merging it loses nothing the user can't
   *    recover. All other (small, must-deliver) frames pass through.
   *  - Over `WS_HARD_LIMIT`: the connection is beyond hope; only then close
   *    with 1009. This mirrors the periodic check in `ws/server.ts`.
   */
  send(msg: ServerMessage): void {
    if (this.ws.readyState !== 1) { // 1 is WebSocket.OPEN
      return;
    }
    const bufferSize = this.ws.bufferedAmount || 0;

    // Only close at the true hard limit — never on ordinary backpressure.
    if (bufferSize > WS_HARD_LIMIT) {
      console.warn(`[WS] Write buffer exceeded ${WS_HARD_LIMIT} bytes (${bufferSize}), closing connection`);
      this.ws.close(1009, "Message Too Big");
      return;
    }

    // Backlog is high but not fatal: coalesce lossy terminal output so we
    // don't queue an unbounded scrollback.
    if (bufferSize > WS_SOFT_LIMIT && msg.type === "session:output") {
      this.coalesceOutput(msg);
      return;
    }

    this.flushCoalesced();
    this.ws.send(JSON.stringify(msg), (err: Error | undefined) => {
      if (err) {
        console.error(`[WS] Send error:`, err);
      }
    });
  }

  /** Accumulate a `session:output` chunk into the coalesced buffer and
   *  schedule a flush so a stall in new sends can't starve the terminal. */
  private coalesceOutput(msg: Extract<ServerMessage, { type: "session:output" }>): void {
    const existing = this.coalescedOutput.get(msg.sessionId) ?? "";
    this.coalescedOutput.set(msg.sessionId, existing + msg.chunk);
    // Bound the coalesced buffer itself so a runaway producer can't grow it
    // without bound; flush it immediately rather than coalescing forever.
    if (this.coalescedOutput.get(msg.sessionId)!.length > WS_SOFT_LIMIT) {
      this.flushCoalesced();
      return;
    }
    if (!this.coalesceFlushTimer) {
      this.coalesceFlushTimer = setTimeout(() => {
        this.coalesceFlushTimer = null;
        this.flushCoalesced();
      }, 100);
    }
  }

  /** Send accumulated coalesced output as one frame per session, but only
   *  once the socket has drained enough that we aren't immediately
   *  re-backpressuring. */
  private flushCoalesced(): void {
    if (this.coalescedOutput.size === 0 || this.ws.readyState !== 1) return;
    const bufferSize = this.ws.bufferedAmount || 0;
    if (bufferSize > WS_SOFT_LIMIT) return; // still backed up — wait for the timer
    for (const [sessionId, chunk] of this.coalescedOutput) {
      this.ws.send(
        JSON.stringify({ type: "session:output", sessionId, chunk }),
        (err: Error | undefined) => {
          if (err) console.error(`[WS] Send error:`, err);
        },
      );
    }
    this.coalescedOutput.clear();
  }

  /**
   * Add session IDs to the subscription set.
   */
  subscribe(sessionIds: string[]): void {
    for (const id of sessionIds) {
      this.subscriptions.add(id);
    }
  }

  /**
   * Remove session IDs from the subscription set.
   */
  unsubscribe(sessionIds: string[]): void {
    for (const id of sessionIds) {
      this.subscriptions.delete(id);
    }
  }

  /**
   * Check if this connection is subscribed to a session.
   */
  isSubscribedTo(sessionId: string): boolean {
    return this.subscriptions.has(sessionId);
  }

  /**
   * Run `fn` under this connection's per-session lock, serializing it against
   * any other open/close for the same sessionId on THIS connection. The
   * critical section spans the entire `fn`, so callers MUST keep the
   * `await stream.attach` park point inside `fn`.
   *
   * Scoped to this connection only — two browser tabs are two WSConnections and
   * legitimately hold two tmux clients, so we never serialize across
   * connections or across tmux names.
   *
   * A terminal remount fires close-then-open back-to-back. Without this lock
   * both handlers await their `stream.attach` concurrently, each spawns a
   * `tmux attach-session` client, but only the last is registered in
   * `openStreams`. The orphaned client keeps emitting chunks → duplicate echo.
   */
  withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    // Chain fn after the previous operation, regardless of whether it
    // succeeded or failed.
    const run = prev.then(fn, fn);
    // The tail swallows the result so a failure cannot poison the chain for
    // subsequent callers.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionLocks.set(sessionId, tail);
    void tail.finally(() => {
      // Clean up the map entry once the chain is idle so it doesn't grow
      // unboundedly for sessions that are only ever opened once.
      if (this.sessionLocks.get(sessionId) === tail) {
        this.sessionLocks.delete(sessionId);
      }
    });
    return run;
  }

  /**
   * Register an open stream for a session.
   */
  registerOpenStream(sessionId: string, entry: OpenStreamEntry): void {
    this.openStreams.set(sessionId, entry);
  }

  /**
   * Unregister an open stream for a session.
   */
  unregisterOpenStream(sessionId: string): void {
    this.openStreams.delete(sessionId);
  }

  /**
   * Check if a stream is open for a session.
   */
  hasOpenStream(sessionId: string): boolean {
    return this.openStreams.has(sessionId);
  }

  /** Register a JSON chat-stream subscription for a session. */
  registerChatStream(sessionId: string, entry: ChatStreamEntry): void {
    this.chatStreams.set(sessionId, entry);
  }

  /** Detach + unregister a JSON chat-stream subscription. Idempotent. */
  unregisterChatStream(sessionId: string): void {
    const entry = this.chatStreams.get(sessionId);
    if (!entry) return;
    entry.stream.off("message", entry.onMessage);
    entry.stream.off("meta", entry.onMeta);
    this.chatStreams.delete(sessionId);
  }

  /**
   * Register the first file watcher for `key` (refCount starts at 1). Only
   * call this when `retainFileWatcher` returned false (no existing entry).
   */
  registerFileWatcher(key: string, watcher: unknown): void {
    this.fileWatches.set(key, { watcher, refCount: 1 });
  }

  /**
   * Add one more consumer to an already-registered file watcher. Returns
   * `false` if no watcher is registered for `key` yet (caller must then
   * create one and call `registerFileWatcher`); returns `true` if an
   * existing watcher was retained (caller does nothing further).
   */
  retainFileWatcher(key: string): boolean {
    const entry = this.fileWatches.get(key);
    if (!entry) return false;
    entry.refCount += 1;
    return true;
  }

  /**
   * Remove one consumer from a file watcher. Returns the underlying watcher
   * instance (for the caller to close) only once refCount reaches 0;
   * returns `null` while other consumers still reference it, or if `key`
   * isn't registered at all.
   */
  releaseFileWatcher(key: string): unknown | null {
    // Drain any debt owed to a dead generation of this key's watcher before
    // touching the current live entry — see `fileWatchDebt` doc comment.
    const debt = this.fileWatchDebt.get(key);
    if (debt !== undefined && debt > 0) {
      if (debt <= 1) this.fileWatchDebt.delete(key);
      else this.fileWatchDebt.set(key, debt - 1);
      return null;
    }
    const entry = this.fileWatches.get(key);
    if (!entry) return null;
    entry.refCount -= 1;
    if (entry.refCount > 0) return null;
    this.fileWatches.delete(key);
    return entry.watcher;
  }

  /**
   * Force-remove a file watcher entry regardless of refCount. Used only from
   * a watcher's own `error` listener — at that point the ONE shared watcher
   * instance for this key has died, so every retainer has lost service
   * regardless of `refCount`; this is intentionally distinct from
   * `releaseFileWatcher`'s per-consumer decrement used by normal
   * `file:unwatch` handling.
   *
   * Every retainer of the dead entry is still expected to eventually call
   * `releaseFileWatcher` (e.g. on component unmount) without knowing the
   * watcher already died. Record that as debt so those future calls no-op
   * instead of decrementing/closing whatever new watcher gets registered
   * under this key afterward (see `fileWatchDebt`).
   */
  unregisterFileWatcher(key: string): void {
    const entry = this.fileWatches.get(key);
    if (entry && entry.refCount > 0) {
      const existingDebt = this.fileWatchDebt.get(key) ?? 0;
      this.fileWatchDebt.set(key, existingDebt + entry.refCount);
    }
    this.fileWatches.delete(key);
  }

  /**
   * Register the first tree watcher for `key` (refCount starts at 1). Only
   * call this when `retainTreeWatcher` returned false (no existing entry).
   */
  registerTreeWatcher(key: string, watcher: unknown): void {
    this.treeWatches.set(key, { watcher, refCount: 1 });
  }

  /**
   * Add one more consumer to an already-registered tree watcher. Returns
   * `false` if no watcher is registered for `key` yet (caller must then
   * create one and call `registerTreeWatcher`); returns `true` if an
   * existing watcher was retained (caller does nothing further).
   */
  retainTreeWatcher(key: string): boolean {
    const entry = this.treeWatches.get(key);
    if (!entry) return false;
    entry.refCount += 1;
    return true;
  }

  /**
   * Remove one consumer from a tree watcher. Returns the underlying watcher
   * instance (for the caller to close) only once refCount reaches 0;
   * returns `null` while other consumers still reference it, or if `key`
   * isn't registered at all.
   */
  releaseTreeWatcher(key: string): unknown | null {
    // Drain any debt owed to a dead generation of this key's watcher before
    // touching the current live entry — see `treeWatchDebt` doc comment.
    const debt = this.treeWatchDebt.get(key);
    if (debt !== undefined && debt > 0) {
      if (debt <= 1) this.treeWatchDebt.delete(key);
      else this.treeWatchDebt.set(key, debt - 1);
      return null;
    }
    const entry = this.treeWatches.get(key);
    if (!entry) return null;
    entry.refCount -= 1;
    if (entry.refCount > 0) return null;
    this.treeWatches.delete(key);
    return entry.watcher;
  }

  /**
   * Force-remove a tree watcher entry regardless of refCount. Used only from
   * a watcher's own `error` listener — at that point the ONE shared watcher
   * instance for this key has died, so every retainer has lost service
   * regardless of `refCount`; this is intentionally distinct from
   * `releaseTreeWatcher`'s per-consumer decrement used by normal
   * `tree:unwatch` handling.
   *
   * Every retainer of the dead entry is still expected to eventually call
   * `releaseTreeWatcher` (e.g. on component unmount) without knowing the
   * watcher already died. Record that as debt so those future calls no-op
   * instead of decrementing/closing whatever new watcher gets registered
   * under this key afterward (see `treeWatchDebt`).
   */
  unregisterTreeWatcher(key: string): void {
    const entry = this.treeWatches.get(key);
    if (entry && entry.refCount > 0) {
      const existingDebt = this.treeWatchDebt.get(key) ?? 0;
      this.treeWatchDebt.set(key, existingDebt + entry.refCount);
    }
    this.treeWatches.delete(key);
  }

  /**
   * Get all subscribed session IDs.
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  /**
   * Cleanup: tear down all subscriptions, streams, and watchers.
   */
  async cleanup(): Promise<void> {
    this.subscriptions.clear();

    // Close all open streams
    for (const entry of this.openStreams.values()) {
      try {
        entry.stream.off("chunk", entry.onChunk);
        await entry.stream.detach(entry.subscriberId);
      } catch (err) {
        console.warn("[WSConnection] Error closing stream during cleanup:", err);
      }
    }
    this.openStreams.clear();

    // Detach all JSON chat-stream subscriptions
    for (const sessionId of Array.from(this.chatStreams.keys())) {
      this.unregisterChatStream(sessionId);
    }

    // Close all file watchers (regardless of refCount — connection teardown
    // closes everything).
    for (const { watcher } of this.fileWatches.values()) {
      try {
        if (watcher && typeof watcher === "object" && "close" in watcher) {
          await (watcher as any).close();
        }
      } catch (err) {
        console.warn("[WSConnection] Error closing file watcher during cleanup:", err);
      }
    }
    this.fileWatches.clear();
    this.fileWatchDebt.clear();

    // Close all tree watchers (regardless of refCount — connection teardown
    // closes everything).
    for (const { watcher } of this.treeWatches.values()) {
      try {
        if (watcher && typeof watcher === "object" && "close" in watcher) {
          await (watcher as any).close();
        }
      } catch (err) {
        console.warn("[WSConnection] Error closing tree watcher during cleanup:", err);
      }
    }
    this.treeWatches.clear();
    this.treeWatchDebt.clear();

    // Drop any pending coalesced output — the socket is gone, there's nothing
    // to flush to.
    if (this.coalesceFlushTimer) {
      clearTimeout(this.coalesceFlushTimer);
      this.coalesceFlushTimer = null;
    }
    this.coalescedOutput.clear();
  }
}
