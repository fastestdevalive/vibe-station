/**
 * AcpTerminalManager — serves the ACP `terminal/*` methods (Requirement 1 /
 * Decision 4). This is the "host-managed terminal" half of the daemon's ACP
 * Client surface: when the wrapped CLI backgrounds a shell command (a dev
 * server, `sleep 60 &`, …), the adapter routes it through here instead of
 * spawning a bare OS child the CLI process itself owns. The daemon then holds
 * the real `ChildProcess` handle, so the work survives past any single turn.
 *
 * Zero CLI-specific logic (AGENTS.md) — this class is identical for every
 * plugin; it only ever sees `{ command, args, cwd, env }`.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface TerminalCreateParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Cap on buffered output kept in memory for `terminal/output`. */
  outputByteLimit?: number;
}

export interface TerminalExitStatus {
  exitCode?: number;
  signal?: string;
}

interface TrackedTerminal {
  child: ChildProcess;
  chunks: Buffer[];
  bytes: number;
  outputByteLimit: number;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  waiters: Array<(status: TerminalExitStatus) => void>;
  released: boolean;
}

const DEFAULT_OUTPUT_BYTE_LIMIT = 1_000_000;

let counter = 0;

export class AcpTerminalManager {
  private readonly terminals = new Map<string, TrackedTerminal>();

  /** True while at least one tracked child is still running (Decision 4's idle-TTL veto). */
  hasLiveTerminals(): boolean {
    for (const t of this.terminals.values()) {
      if (t.exitStatus === null) return true;
    }
    return false;
  }

  create(params: TerminalCreateParams): { terminalId: string } {
    const terminalId = `term-${++counter}-${Date.now()}`;
    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd,
      env: params.env ? { ...process.env, ...params.env } : process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tracked: TrackedTerminal = {
      child,
      chunks: [],
      bytes: 0,
      outputByteLimit: params.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT,
      truncated: false,
      exitStatus: null,
      waiters: [],
      released: false,
    };
    const onData = (buf: Buffer): void => {
      tracked.bytes += buf.length;
      tracked.chunks.push(buf);
      if (tracked.bytes > tracked.outputByteLimit) {
        tracked.truncated = true;
        // Keep only the tail within the limit.
        let total = 0;
        const kept: Buffer[] = [];
        for (let i = tracked.chunks.length - 1; i >= 0; i--) {
          const c = tracked.chunks[i]!;
          total += c.length;
          kept.unshift(c);
          if (total >= tracked.outputByteLimit) break;
        }
        tracked.chunks = kept;
        tracked.bytes = total;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", (code, signal) => {
      const status: TerminalExitStatus = {
        ...(code !== null ? { exitCode: code } : {}),
        ...(signal ? { signal } : {}),
      };
      tracked.exitStatus = status;
      for (const w of tracked.waiters.splice(0)) w(status);
    });
    this.terminals.set(terminalId, tracked);
    return { terminalId };
  }

  output(terminalId: string): { output: string; truncated: boolean; exitStatus?: TerminalExitStatus } {
    const t = this.requireTerminal(terminalId);
    return {
      output: Buffer.concat(t.chunks).toString("utf8"),
      truncated: t.truncated,
      ...(t.exitStatus ? { exitStatus: t.exitStatus } : {}),
    };
  }

  waitForExit(terminalId: string): Promise<{ exitStatus: TerminalExitStatus }> {
    const t = this.requireTerminal(terminalId);
    if (t.exitStatus) return Promise.resolve({ exitStatus: t.exitStatus });
    return new Promise((resolve) => {
      t.waiters.push((status) => resolve({ exitStatus: status }));
    });
  }

  kill(terminalId: string): void {
    const t = this.requireTerminal(terminalId);
    if (t.exitStatus !== null) return; // already exited
    try {
      if (t.child.pid) process.kill(-t.child.pid, "SIGKILL");
      else t.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  release(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    if (t.exitStatus === null) this.kill(terminalId);
    t.released = true;
    this.terminals.delete(terminalId);
  }

  /** Teardown — hard-kill every tracked terminal (Requirement 2 / connection dispose). */
  killAll(): void {
    for (const id of [...this.terminals.keys()]) this.release(id);
  }

  private requireTerminal(terminalId: string): TrackedTerminal {
    const t = this.terminals.get(terminalId);
    if (!t) throw new Error(`unknown terminalId: ${terminalId}`);
    return t;
  }
}
