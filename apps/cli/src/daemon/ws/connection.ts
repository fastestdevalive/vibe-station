import type { WebSocket } from "@fastify/websocket";
import type { ServerMessage } from "./protocol.js";
import type { SessionStream } from "./streams/sessionStream.js";

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
  fileWatches: Map<string, unknown> = new Map(); // key -> FSWatcher (public for handlers)
  treeWatches: Map<string, unknown> = new Map(); // key -> FSWatcher (public for handlers)
  readonly id: string; // Unique identifier for this connection

  constructor(private ws: WebSocket) {
    this.id = Math.random().toString(36).slice(2);
  }

  /**
   * Send a message to the client. Handles backpressure: if write buffer
   * exceeds ~1MB, close with code 1009.
   */
  send(msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    const bufferSize = this.ws.bufferedAmount || 0;

    // If write buffer is already large, reject to avoid pileup
    if (bufferSize > 1_000_000) {
      console.warn(`[WS] Write buffer exceeded 1MB (${bufferSize} bytes), closing connection`);
      this.ws.close(1009, "Message Too Big");
      return;
    }

    this.ws.send(json, (err: Error | undefined) => {
      if (err) {
        console.error(`[WS] Send error:`, err);
      }
    });
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

  /**
   * Register a file watcher.
   */
  registerFileWatcher(key: string, watcher: unknown): void {
    this.fileWatches.set(key, watcher);
  }

  /**
   * Unregister a file watcher.
   */
  unregisterFileWatcher(key: string): void {
    this.fileWatches.delete(key);
  }

  /**
   * Register a tree watcher.
   */
  registerTreeWatcher(key: string, watcher: unknown): void {
    this.treeWatches.set(key, watcher);
  }

  /**
   * Unregister a tree watcher.
   */
  unregisterTreeWatcher(key: string): void {
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

    // Close all file watchers
    for (const watcher of this.fileWatches.values()) {
      try {
        if (watcher && typeof watcher === "object" && "close" in watcher) {
          await (watcher as any).close();
        }
      } catch (err) {
        console.warn("[WSConnection] Error closing file watcher during cleanup:", err);
      }
    }
    this.fileWatches.clear();

    // Close all tree watchers
    for (const watcher of this.treeWatches.values()) {
      try {
        if (watcher && typeof watcher === "object" && "close" in watcher) {
          await (watcher as any).close();
        }
      } catch (err) {
        console.warn("[WSConnection] Error closing tree watcher during cleanup:", err);
      }
    }
    this.treeWatches.clear();
  }
}
