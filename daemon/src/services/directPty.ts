// @ts-nocheck
import { EventEmitter } from "node:events";
import { spawn as ptySpawn, type IPty } from "node-pty";
import type { SessionStream } from "../ws/streams/sessionStream.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";

/**
 * Manages direct PTY spawning and streaming (no tmux intermediary).
 * One DirectPtyStream per session, shared across multiple subscribers.
 *
 * Difference from TmuxOutputStream:
 * - Each instance runs the actual program (no tmux session).
 * - Multiple subscribers share one PTY via a ring buffer + fanout callbacks.
 * - Lifetime = PTY's lifetime (when the program exits, the stream closes).
 * - When a subscriber detaches, only that subscriber is removed; PTY lives on.
 * - Event-driven exit detection via pty.onExit, not polling.
 */
export class DirectPtyStream extends EventEmitter implements SessionStream {
  private pty: IPty;
  private ringBuffer = Buffer.alloc(64 * 1024); // 64 KB max
  private ringBufferPos = 0; // Write head position (wraps at 64 KB)
  private ringBufferLength = 0; // How many bytes are currently in buffer
  /**
   * Set of subscribed WS connection identifiers. Used purely for tracking
   * presence (e.g. activeSubscriberId arbitration); fanout itself goes
   * through this stream's `'chunk'` EventEmitter — one emit per PTY chunk,
   * dispatched to all attached `chunk` listeners. A previous version
   * fan-out via per-subscriber callbacks that *each* called `emit("chunk")`,
   * causing N×M chunk deliveries.
   */
  private subscribers = new Set<string>();
  /**
   * The most recently attached subscriber. Only this subscriber's resize
   * calls move the PTY — older clients are passive observers and don't
   * constrain the size. Cleared when that subscriber detaches; the PTY
   * keeps its last size until the next attach claims it.
   */
  private activeSubscriberId: string | null = null;
  private exited = false;
  private sentinelHits = new Set<string>();
  private sentinelWaiters = new Map<string, (hit: boolean) => void>();
  private sessionId: string;
  private projectId: string;
  private worktreeId: string;

  constructor(pty: IPty, sessionId: string, projectId: string, worktreeId: string) {
    super();
    // Long-lived stream with many connect/disconnect cycles can accumulate
    // chunk + close + error listeners over time (one per WSConnection). 0 = no
    // cap. We rely on stream.off cleanup on detach to avoid actual leaks.
    this.setMaxListeners(0);
    this.pty = pty;
    this.sessionId = sessionId;
    this.projectId = projectId;
    this.worktreeId = worktreeId;
    this.setupPtyHandlers();
  }

  private setupPtyHandlers(): void {
    this.pty.onData((data: string) => {
      if (this.exited) return;

      // Append to ring buffer
      const bytes = Buffer.from(data, "utf8");
      for (const byte of bytes) {
        this.ringBuffer[this.ringBufferPos] = byte;
        this.ringBufferPos = (this.ringBufferPos + 1) % (64 * 1024);
        if (this.ringBufferLength < 64 * 1024) {
          this.ringBufferLength++;
        }
      }

      // Check sentinel watchers
      for (const needle of this.sentinelWaiters.keys()) {
        if (!this.sentinelHits.has(needle) && data.includes(needle)) {
          this.sentinelHits.add(needle);
          const waiter = this.sentinelWaiters.get(needle);
          if (waiter) {
            this.sentinelWaiters.delete(needle);
            waiter(true);
          }
        }
      }

      // Single emit dispatches to all `chunk` listeners (one per WS connection
      // attached via sessionOpen). Do NOT loop over subscribers and emit per
      // subscriber — that would deliver each chunk N×M times.
      this.emit("chunk", data);
    });

    this.pty.onExit(({ exitCode }) => {
      if (this.exited) return;
      this.exited = true;

      // Fail any pending sentinel watchers
      for (const [needle, waiter] of this.sentinelWaiters) {
        waiter(false);
      }
      this.sentinelWaiters.clear();

      this.emit("close");
      directPtyRegistry.delete(this.sessionId);

      // Notify lifecycle service of exit (event-driven — no poll-tick delay).
      // Dynamic import breaks the potential circular dep chain.
      void import("../services/lifecycle.js").then(({ markSessionExited }) =>
        markSessionExited(this.projectId, this.worktreeId, this.sessionId).catch((err) => {
          console.error("[DirectPtyStream] markSessionExited failed:", err);
        }),
      );
    });
  }

  /**
   * Begin streaming output to a subscriber.
   * - Replays ringBuffer to the new subscriber synchronously.
   * - Registers the subscriberId for live fan-out.
   * - Claims the PTY size for this subscriber (latest-attach-wins).
   * - If already exited, emits 'opened', 'chunk' (buffer), then 'close' asynchronously.
   */
  async attach(cols: number, rows: number, subscriberId: string): Promise<void> {
    this.emit("opened");

    // Replay buffer
    if (this.ringBufferLength > 0) {
      const chunk = this.getRingBufferContents();
      this.emit("chunk", chunk);
    }

    // If already exited, close on next microtask so client can install handler first
    if (this.exited) {
      queueMicrotask(() => {
        this.emit("close");
      });
      return;
    }

    // This subscriber becomes the active one and claims the PTY size.
    this.activeSubscriberId = subscriberId;
    if (cols !== this.pty.cols || rows !== this.pty.rows) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        // PTY may be dead
      }
    }

    // Track presence — fanout itself happens via the 'chunk' EventEmitter.
    this.subscribers.add(subscriberId);
  }

  /** Forward client keystrokes. Fan-in from all subscribers to one PTY. */
  write(data: string): void {
    if (!this.exited && this.pty) {
      try {
        this.pty.write(data);
      } catch (err) {
        // PTY is dead
      }
    }
  }

  /**
   * Resize the PTY — only honoured from the active subscriber (the most recently
   * attached one). Resize calls from passive observers are silently dropped so they
   * don't fight the active client over PTY dimensions. A passive client can reclaim
   * the PTY by re-attaching (sending session:open again).
   */
  resize(cols: number, rows: number, subscriberId?: string): void {
    if (this.exited || !this.pty) return;
    if (subscriberId && subscriberId !== this.activeSubscriberId) return;
    try {
      if (cols !== this.pty.cols || rows !== this.pty.rows) {
        this.pty.resize(cols, rows);
      }
    } catch {
      // PTY is dead
    }
  }

  /**
   * Remove a subscriber. PTY stays alive (lifetime = PTY's own lifetime).
   * If this was the active subscriber, clears the active slot — PTY keeps its
   * current size until the next attach claims it.
   */
  async detach(subscriberId: string): Promise<void> {
    this.subscribers.delete(subscriberId);
    if (this.activeSubscriberId === subscriberId) {
      this.activeSubscriberId = null;
    }
  }

  /**
   * Wait until the ring buffer contains `needle`, or until `timeoutMs`.
   * Returns true if found, false on timeout.
   * Uses a boolean flag inside pty.onData, not buffer scans, to handle ring-buffer wrap.
   */
  async waitForOutput(needle: string, timeoutMs: number): Promise<boolean> {
    // Check buffer first — maybe we already have it
    const current = this.getRingBufferContents();
    if (current.includes(needle)) {
      return true;
    }

    // Already hit?
    if (this.sentinelHits.has(needle)) {
      return true;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sentinelWaiters.delete(needle);
        resolve(false);
      }, timeoutMs);

      this.sentinelWaiters.set(needle, (hit: boolean) => {
        clearTimeout(timer);
        resolve(hit);
      });
    });
  }

  /**
   * Return the last `maxBytes` bytes of ring buffer as a string.
   * Used by the lifecycle poller for idle-detection hashing.
   */
  getRecentOutput(maxBytes: number): string {
    const full = this.getRingBufferContents();
    if (full.length <= maxBytes) return full;
    return full.slice(full.length - maxBytes);
  }

  /** Kill the PTY (triggering onExit cleanup). Idempotent. */
  kill(): void {
    if (this.exited) return;
    try {
      this.pty.kill();
    } catch {
      // Best-effort
    }
  }

  /** Return the current contents of the ring buffer as a string. */
  private getRingBufferContents(): string {
    if (this.ringBufferLength === 0) return "";

    const capacity = 64 * 1024;
    if (this.ringBufferLength < capacity) {
      // Buffer hasn't wrapped yet — simple copy
      return this.ringBuffer.subarray(0, this.ringBufferLength).toString("utf8");
    }

    // Buffer has wrapped — copy from writeHead to end, then from 0 to writeHead
    const chunk1 = this.ringBuffer.subarray(this.ringBufferPos).toString("utf8");
    const chunk2 = this.ringBuffer.subarray(0, this.ringBufferPos).toString("utf8");
    return chunk1 + chunk2;
  }
}

export class DirectPtyBackend {
  static async spawn(opts: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    sessionId: string;
    projectId: string;
    worktreeId: string;
  }): Promise<DirectPtyStream> {
    // Inherit the daemon's process.env (PATH, HOME, SHELL, NVM bits, etc.) so
    // shell launchers can resolve binaries like `claude`. Overlay caller-provided
    // opts.env (VST_*, CLAUDECODE, …) on top — same merge order tmux mode uses,
    // where `tmux new-session -e KEY=VAL` overrides values inherited via execFile's
    // `env: process.env`.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    for (const [k, v] of Object.entries(opts.env)) {
      env[k] = v;
    }
    env.TERM = "xterm-256color";

    const pty = ptySpawn(opts.command, opts.args, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    });

    const stream = new DirectPtyStream(pty, opts.sessionId, opts.projectId, opts.worktreeId);
    directPtyRegistry.set(opts.sessionId, stream);
    return stream;
  }
}
