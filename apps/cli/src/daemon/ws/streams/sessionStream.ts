import type { EventEmitter } from "node:events";

export interface SessionStream extends EventEmitter {
  /**
   * Begin streaming output to a subscriber.
   * - Tmux mode: spawns `tmux attach-session` (one PTY per call); subscriberId is ignored
   *   because each TmuxOutputStream is a single-subscriber object owned by one WSConnection.
   * - Direct mode: replays ringBuffer to the new subscriber synchronously, then registers
   *   the subscriberId for live fan-out. Multiple subscribers share one stream/PTY.
   */
  attach(cols: number, rows: number, subscriberId: string): Promise<void>;

  /** Forward client keystrokes. Direct mode: bytes from all subscribers fan-in to one PTY. */
  write(data: string): void;

  /**
   * Resize the PTY.
   * - Tmux mode: applies directly (single subscriber per instance, last-writer-wins fine).
   * - Direct mode: records the caller's preferred size and applies the minimum across all
   *   active subscribers so every client can render without truncation.
   *   subscriberId must match the one passed to attach().
   */
  resize(cols: number, rows: number, subscriberId?: string): void;

  /**
   * Stop streaming for one subscriber.
   * - Tmux mode: tears down the PTY (single subscriber → kill the attach-session).
   * - Direct mode: removes only this subscriber from the set; PTY stays alive while
   *   any subscriber remains, AND while no subscribers remain (lifetime = PTY's lifetime,
   *   matches emdash).
   */
  detach(subscriberId: string): Promise<void>;

  /** Events: 'opened' | 'chunk' (string) | 'error' (string) | 'close' */

  /**
   * Kill the underlying PTY. Only meaningful for direct-pty streams.
   * Tmux streams do not implement this — callers must check session.useTmux
   * before calling.
   */
  kill?(): void;

  /**
   * Return the most recent `maxBytes` bytes of ring-buffer output as a string.
   * Only implemented by direct-pty streams; used by the lifecycle poller for
   * idle-detection hashing.
   */
  getRecentOutput?(maxBytes: number): string;
}
