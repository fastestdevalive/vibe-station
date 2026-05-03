import { exec, execSync } from "node:child_process";
import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";

const execAsync = promisify(exec);

/**
 * Manages tmux pane attachment and output streaming.
 * Handles scrollback capture and live stream via tmux pipe-pane + FIFO.
 */
export class TmuxOutputStream extends EventEmitter {
  private tmuxName: string;
  private fifoPath: string | null = null;
  private readStream: any = null;
  private closed = false;

  constructor(tmuxName: string) {
    super();
    this.tmuxName = tmuxName;
  }

  /**
   * Attach to a tmux pane, resize it, capture scrollback, and start live stream.
   * Emits:
   * - 'opened': after successful attachment and scrollback
   * - 'chunk': for each output chunk (scrollback + live)
   * - 'error': on attachment failure
   * - 'close': when the stream is closed
   */
  async attach(cols: number, rows: number): Promise<void> {
    try {
      // Resize the tmux window
      try {
        execSync(`tmux resize-window -t ${this.tmuxName} -x ${cols} -y ${rows}`, { timeout: 5000 });
      } catch (err) {
        // Log but don't fail — resize is best-effort
        console.warn(`[TmuxStream] Failed to resize window ${this.tmuxName}:`, err);
      }

      // Capture scrollback (~10k lines)
      const { stdout: scrollback } = await execAsync(
        `tmux capture-pane -t ${this.tmuxName} -p -S -10000 -e`,
        { timeout: 5000 },
      );

      // Emit initial scrollback chunk
      if (scrollback) {
        this.emit("chunk", scrollback);
      }

      this.emit("opened");

      // Start live stream via pipe-pane
      this._startLiveStream();
    } catch (err) {
      this.closed = true;
      this.emit("error", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Start live stream via tmux pipe-pane using a temporary FIFO.
   */
  private async _startLiveStream(): Promise<void> {
    try {
      // Create a temporary FIFO using mkdtemp + mkfifo workaround
      // For now, use a simple approach: spawn a subshell that tails the fifo
      const tmpDir = await mkdtemp(join(tmpdir(), "vst-tmux-"));
      this.fifoPath = join(tmpDir, "output.fifo");

      // Create the FIFO
      execSync(`mkfifo ${this.fifoPath}`, { timeout: 5000 });

      // Start pipe-pane to write to the FIFO
      // Use 'cat > fifo' as the command
      try {
        execSync(`tmux pipe-pane -t ${this.tmuxName} -O "cat > ${this.fifoPath}"`, {
          timeout: 5000,
        });
      } catch (err) {
        // pipe-pane may return non-zero — that's okay
        console.warn(`[TmuxStream] pipe-pane returned error (expected):`, err);
      }

      // Open the FIFO for reading
      this.readStream = createReadStream(this.fifoPath, { encoding: "utf8" });

      this.readStream.on("data", (chunk: string) => {
        if (!this.closed) {
          this.emit("chunk", chunk);
        }
      });

      this.readStream.on("error", (err: Error) => {
        if (!this.closed) {
          console.error(`[TmuxStream] Read stream error:`, err);
          this.emit("error", err.message);
        }
      });

      this.readStream.on("close", () => {
        if (!this.closed) {
          this.closed = true;
          this._cleanup();
        }
      });

      this.readStream.on("end", () => {
        if (!this.closed) {
          this.closed = true;
          this._cleanup();
        }
      });
    } catch (err) {
      this.closed = true;
      this.emit("error", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Detach from the pane and stop streaming.
   */
  async detach(): Promise<void> {
    if (this.closed) return;

    this.closed = true;

    // Stop the pipe-pane
    try {
      execSync(`tmux pipe-pane -t ${this.tmuxName}`, { timeout: 5000 });
    } catch (err) {
      console.warn(`[TmuxStream] Failed to stop pipe-pane:`, err);
    }

    // Close the read stream
    if (this.readStream) {
      try {
        this.readStream.destroy();
      } catch (err) {
        // best-effort
      }
    }

    this._cleanup();
    this.emit("close");
  }

  private async _cleanup(): Promise<void> {
    if (this.fifoPath) {
      try {
        await unlink(this.fifoPath);
      } catch (err) {
        // best-effort
      }
      this.fifoPath = null;
    }
  }
}
