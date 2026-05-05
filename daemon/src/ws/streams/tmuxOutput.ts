// @ts-nocheck
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { spawn as ptySpawn, type IPty } from "node-pty";
import type { SessionStream } from "./sessionStream.js";

/**
 * Manages a tmux session attachment via a real PTY (node-pty + `tmux
 * attach-session`). tmux drives the terminal via cursor escape sequences
 * flowing over the PTY byte stream — same model as a user attaching from
 * a real terminal — so xterm receives a faithful, in-sync byte stream and
 * never has to re-render a static snapshot.
 *
 * Why this instead of capture-pane + pipe-pane:
 * - capture-pane returns rendered text only; it loses cursor position,
 *   attribute state, mode flags, scrolling regions, alternate-screen
 *   state, etc. Replaying that text into xterm produces "shifted lines"
 *   and cursor desync that no patching can fully fix.
 * - With node-pty + attach-session, tmux uses the same protocol it would
 *   use against any interactive client; xterm just renders what arrives.
 *
 * UX choices:
 * - We enable tmux mouse mode (`set-option mouse on`) so the wheel auto-
 *   enters tmux's copy-mode for scrollback. With `tmux attach-session`,
 *   TUI agents like claude run in xterm's alternate buffer where xterm-
 *   native wheel scroll has nothing to scroll. Mouse mode delegates wheel
 *   events to tmux which gives the user real scrollback. (The previous
 *   FIFO/capture-pane path put everything in xterm's normal buffer, so
 *   wheel scrolling worked there without mouse mode — that reasoning
 *   doesn't apply here.)
 * - We disable the tmux status bar so it doesn't eat a row at the bottom.
 *
 * Persistence: killing the PTY (SIGHUP) detaches this client without
 * touching the underlying tmux session — same as a user closing their
 * terminal window. The session keeps running for the next attach.
 *
 * SessionStream implementation: single-subscriber per instance (one per WSConnection).
 * The subscriberId parameter is ignored because each TmuxOutputStream is owned by
 * one WSConnection, not shared across subscribers.
 */
export class TmuxOutputStream extends (EventEmitter as any) implements SessionStream {
  private tmuxName: string;
  private pty: IPty | null = null;
  private closed = false;

  constructor(tmuxName: string) {
    super();
    this.tmuxName = tmuxName;
  }

  /**
   * Attach to the tmux session. Emits:
   * - 'opened' once the PTY has been spawned
   * - 'chunk' for every byte chunk from the PTY (live + initial redraw)
   * - 'error' on attach failure
   * - 'close' when the PTY exits
   *
   * subscriberId: ignored (single-subscriber per instance)
   */
  async attach(cols: number, rows: number, subscriberId: string): Promise<void> {
    try {
      // Pre-flight: confirm the tmux session exists. Without this check, a
      // missing/dead session causes `tmux attach-session` to print
      // "can't find session: <name>" into the pty before exiting non-zero —
      // which lands as garbage in the user's terminal viewport. Bail out
      // early with a clean error instead.
      try {
        execSync(`tmux has-session -t ${this.tmuxName}`, { stdio: "ignore", timeout: 5000 });
      } catch {
        this.closed = true;
        this.emit("error", `Session '${this.tmuxName}' not running`);
        return;
      }

      // Hide tmux's status line for this session — keeps the visible area
      // equal to the requested rows. Best-effort: a failure here just costs
      // us one row of green status bar, not a broken session.
      try {
        execSync(`tmux set-option -t ${this.tmuxName} status off`, { timeout: 5000 });
      } catch (err) {
        console.warn(`[TmuxStream] Failed to disable status bar for ${this.tmuxName}:`, err);
      }

      // Enable tmux mouse mode so wheel events trigger copy-mode scrolling.
      // Best-effort — failure here just means the user loses wheel scroll.
      try {
        execSync(`tmux set-option -t ${this.tmuxName} mouse on`, { timeout: 5000 });
      } catch (err) {
        console.warn(`[TmuxStream] Failed to enable mouse for ${this.tmuxName}:`, err);
      }

      // Force the pane to match the client size BEFORE attach. We can't rely
      // on the attach-client SIGWINCH alone — tmux's `window-size` option
      // can be `smallest` or `manual`, in which case the pane keeps the
      // size from a prior client attach (often 80x24). resize-window is
      // unconditional and works regardless of `window-size` mode.
      this.forceWindowSize(cols, rows);

      // Filter undefined env values for node-pty's stricter signature.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") env[k] = v;
      }
      env.TERM = "xterm-256color";

      const pty = ptySpawn("tmux", ["attach-session", "-t", this.tmuxName], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: env.HOME || "/",
        env,
      });

      this.pty = pty;

      pty.onData((data: string) => {
        if (this.closed) return;
        this.emit("chunk", data);
      });

      pty.onExit(({ exitCode }) => {
        if (this.closed) return;
        this.closed = true;
        // Exit code 0 from `tmux attach-session` is a clean detach (the
        // session itself is fine); anything else is an attach failure
        // (most commonly: session was killed while we were attached).
        if (exitCode !== 0) {
          this.emit("error", `tmux attach-session exited with code ${exitCode}`);
        } else {
          this.emit("close");
        }
      });

      this.emit("opened");
    } catch (err) {
      this.closed = true;
      this.emit("error", err instanceof Error ? err.message : String(err));
    }
  }

  /** Forward keystrokes from the client to the attached tmux pane. */
  write(data: string): void {
    if (this.pty && !this.closed) {
      this.pty.write(data);
    }
  }

  /** Resize the PTY (and through it, tmux's pane) to match the client. subscriberId ignored (single subscriber). */
  resize(cols: number, rows: number, _subscriberId?: string): void {
    if (this.pty && !this.closed) {
      try {
        this.pty.resize(cols, rows);
      } catch (err) {
        // Common transient causes: PTY just exited, fd already closed.
        // Surfacing these as warnings clutters logs without helping.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/EBADF|ENOTTY|ioctl|not open/.test(msg)) {
          console.warn(`[TmuxStream] resize failed for ${this.tmuxName}:`, err);
        }
      }
      // Belt-and-braces: also issue an explicit resize-window. pty.resize
      // alone is sufficient when `window-size` is `latest` (the default),
      // but does nothing under `manual` or when our client isn't the
      // smallest under `smallest`. resize-window is unconditional.
      this.forceWindowSize(cols, rows);
    }
  }

  private forceWindowSize(cols: number, rows: number): void {
    try {
      execSync(`tmux resize-window -t ${this.tmuxName} -x ${cols} -y ${rows}`, {
        timeout: 5000,
      });
    } catch (err) {
      console.warn(`[TmuxStream] resize-window failed for ${this.tmuxName}:`, err);
    }
  }

  /** Detach this client. Underlying tmux session keeps running. subscriberId is ignored. */
  async detach(subscriberId: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.pty) {
      try {
        // SIGHUP — the same signal a user's terminal sends on close.
        // tmux interprets this as the client going away and detaches
        // without killing the session.
        this.pty.kill();
      } catch (err) {
        console.warn(`[TmuxStream] Error killing pty for ${this.tmuxName}:`, err);
      }
      this.pty = null;
    }

    // Defense in depth: drop any listeners that might still hold a reference
    // to this stream's events. The closed flag already prevents emit("chunk")
    // from running, but if a stray listener was attached and not paired with
    // a matching off() (e.g. a leftover from a re-open race) it would
    // otherwise sit forever. Pairs with the off() in sessionOpen.ts's stale
    // handling, but is unconditional here so no listener can outlive detach.
    this.removeAllListeners();

    this.emit("close");
  }
}
