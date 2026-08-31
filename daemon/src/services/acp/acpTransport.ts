/**
 * AcpConnection — one persistent Agent Client Protocol (ACP) JSON-RPC
 * connection per session (Decision 1). Spawns the agent process once,
 * `initialize`s it, opens (or loads) exactly one ACP session, and serves
 * `session/prompt` for every turn over that SAME connection — replacing the
 * per-turn one-shot spawn this plan removes (Decision 2).
 *
 * Zero CLI-specific logic (AGENTS.md): a plugin supplies only launch argv/env
 * (`AcpLaunchSpec`) and an optional `normalize` enrich hook; everything below
 * is identical for every plugin.
 *
 * Wire format: ACP is JSON-RPC 2.0 over stdio, one JSON object per line
 * (newline-delimited — no Content-Length framing).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { AcpTerminalManager, type TerminalCreateParams } from "./acpTerminalManager.js";
import { readTextFile, writeTextFile } from "./acpFileSystem.js";
import { normalizeSessionUpdate, type AcpEnrichHook, type AcpSessionUpdate } from "./normalize.js";
import type { NormalizedEvent, NormalizedEventProvider } from "../../types.js";

export class ConnectionSpawnFailed extends Error {}
export class InitializeFailed extends Error {}
export class SessionLoadFailed extends Error {}

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string };

export type StopReason = "end_turn" | "cancelled" | "refusal" | "max_tokens" | "max_turn_requests";

export interface AcpLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Mirrors `onSpawn` in `TurnContext` (Decision 7) — feeds the boot-sweep pidfile. */
  onSpawn?: (pid: number) => void;
  /** ms to wait for `initialize` to resolve before ConnectionSpawnFailed/InitializeFailed. */
  initializeTimeoutMs?: number;
}

/** 30 minutes (Decision 4) — a connection with zero live terminals idles out after this. */
const IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type PendingResolver = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export class AcpConnection {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingResolver>();
  private sessionId: string | null = null;
  private agentCapabilities: Record<string, unknown> = {};
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private activeUpdateSink: ((u: AcpSessionUpdate) => void) | null = null;
  readonly terminals = new AcpTerminalManager();

  constructor(
    private readonly spec: AcpLaunchSpec,
    private readonly provider: NormalizedEventProvider,
    private readonly enrich?: AcpEnrichHook,
  ) {}

  /** Spawn the agent process and complete the ACP `initialize` handshake. */
  async initialize(): Promise<{ loadSession: boolean }> {
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env ? { ...process.env, ...this.spec.env } : process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    if (child.pid) this.spec.onSpawn?.(child.pid);

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));

    child.on("close", () => {
      // Reject every still-pending request — the process is gone, nothing
      // will ever answer them.
      for (const [id, p] of this.pending) {
        p.reject(new Error(`agent process closed${stderr ? `: ${stderr.trim()}` : ""}`));
        this.pending.delete(id);
      }
    });

    // Fail-closed-before-ready race (mirrors emdash `acp-agent-connection.ts:118-119`):
    // if the process exits/errors before `initialize` resolves, surface a typed
    // failure instead of hanging the caller forever.
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once("error", (err) => reject(new ConnectionSpawnFailed(String(err))));
      child.once("close", (code) => {
        reject(new ConnectionSpawnFailed(`agent process exited (${code}) before ready${stderr ? `: ${stderr.trim()}` : ""}`));
      });
    });

    const timeoutMs = this.spec.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new InitializeFailed(`initialize timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const result = (await Promise.race([
        this.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        }),
        spawnFailed,
        timeout,
      ])) as { agentCapabilities?: Record<string, unknown> };
      this.agentCapabilities = result.agentCapabilities ?? {};
    } catch (err) {
      if (err instanceof ConnectionSpawnFailed || err instanceof InitializeFailed) throw err;
      throw new InitializeFailed(String(err));
    }

    this.resetIdleTimer();
    return { loadSession: this.agentCapabilities.loadSession === true };
  }

  /** `session/new` — mint a fresh ACP session for `cwd`. */
  async newSession(cwd: string): Promise<string> {
    const result = (await this.request("session/new", { cwd, mcpServers: [] })) as { sessionId: string };
    this.sessionId = result.sessionId;
    this.resetIdleTimer();
    return result.sessionId;
  }

  /**
   * `session/load` (Decision 5) — resume a prior ACP session. Throws
   * `SessionLoadFailed` on any JSON-RPC error; the caller falls through to
   * `newSession` and emits a `status` event naming the fallback. Never call
   * this unless `initialize()` reported `loadSession: true`.
   */
  async loadSession(cwd: string, priorAcpSessionId: string): Promise<void> {
    try {
      await this.request("session/load", { sessionId: priorAcpSessionId, cwd, mcpServers: [] });
      this.sessionId = priorAcpSessionId;
      this.resetIdleTimer();
    } catch (err) {
      throw new SessionLoadFailed(String(err));
    }
  }

  /** True once a `session/new`/`session/load` id is established. */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Run one turn (`session/prompt`, Decision 2). Returns an async-iterable of
   * raw `NormalizedEvent`s (already mapped by the shared normalizer) plus a
   * `result` promise resolving with the turn's `stopReason` when
   * `session/prompt` itself resolves — THAT resolution, not process exit, is
   * the turn-done signal.
   */
  sendPrompt(
    sessionId: string,
    prompt: PromptBlock[],
    signal: AbortSignal,
  ): { updates: AsyncIterable<NormalizedEvent>; result: Promise<{ stopReason: StopReason }> } {
    this.resetIdleTimer();
    const queue: NormalizedEvent[] = [];
    const waiters: Array<() => void> = [];
    let done = false;

    const push = (ev: NormalizedEvent): void => {
      queue.push(ev);
      const w = waiters.shift();
      if (w) w();
    };

    this.activeUpdateSink = (raw: AcpSessionUpdate) => {
      const ev = normalizeSessionUpdate(raw, sessionId, this.provider, this.enrich);
      if (ev) push(ev);
    };

    const onAbort = (): void => {
      this.cancelActivePrompt();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const resultPromise = this.request("session/prompt", {
      sessionId,
      prompt,
    })
      .then((r) => r as { stopReason: StopReason })
      .finally(() => {
        done = true;
        this.activeUpdateSink = null;
        signal.removeEventListener("abort", onAbort);
        const w = waiters.shift();
        if (w) w();
      });

    async function* updates(): AsyncGenerator<NormalizedEvent> {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    }

    return { updates: updates(), result: resultPromise };
  }

  /** ACP `session/cancel` (Decision 3) — a notification, no response expected. */
  cancelActivePrompt(): void {
    if (!this.sessionId) return;
    this.notify("session/cancel", { sessionId: this.sessionId });
  }

  hasLiveTerminals(): boolean {
    return this.terminals.hasLiveTerminals();
  }

  /**
   * Hard teardown (Requirement 2 / Decision 9): kill every live terminal, then
   * group-kill the agent process itself. Idempotent, never throws.
   */
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      this.disposed = true;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.terminals.killAll();
      for (const [id, p] of this.pending) {
        p.reject(new Error("connection disposed"));
        this.pending.delete(id);
      }
      const child = this.child;
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              /* already gone */
            }
            resolve();
          }, 2000);
          child.once("close", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    })();
    return this.disposePromise;
  }

  // --- idle TTL (Decision 4) ---

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.disposed) return;
    this.idleTimer = setTimeout(() => {
      if (this.hasLiveTerminals()) {
        // Pinned open by a live background terminal — re-arm and check again later.
        this.resetIdleTimer();
        return;
      }
      void this.dispose();
    }, IDLE_TTL_MS);
    this.idleTimer.unref?.();
  }

  // --- JSON-RPC transport internals ---

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcRequest | JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // non-JSON stdout noise — tolerate (mirrors per-plugin NDJSON parsing today)
    }
    if (!msg || typeof msg !== "object") return;

    // A response to OUR request (has `id` and either `result` or `error`, no `method`).
    if ("id" in msg && !("method" in msg) && (("result" in msg) || ("error" in msg))) {
      const resp = msg as JsonRpcResponse;
      const pending = this.pending.get(resp.id as number);
      if (!pending) return;
      this.pending.delete(resp.id as number);
      if (resp.error) pending.reject(new Error(resp.error.message));
      else pending.resolve(resp.result);
      return;
    }

    // A request/notification FROM the agent.
    if ("method" in msg) {
      const req = msg as JsonRpcRequest;
      void this.handleAgentMessage(req);
    }
  }

  private async handleAgentMessage(req: JsonRpcRequest): Promise<void> {
    const respond = (result: unknown): void => {
      if (req.id === undefined) return; // notification — no response
      this.writeLine({ jsonrpc: "2.0", id: req.id, result });
    };
    const respondError = (message: string): void => {
      if (req.id === undefined) return;
      this.writeLine({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message } });
    };

    try {
      switch (req.method) {
        case "session/update": {
          const params = req.params as { sessionId: string; update: AcpSessionUpdate };
          this.activeUpdateSink?.(params.update);
          return; // notification, no response
        }
        case "session/request_permission": {
          // Auto-approve every permission request — matches the trust model
          // every other launch path in this codebase already uses
          // (`--dangerously-skip-permissions` for the legacy one-shot spawn
          // and terminal launches, agy.ts's own equivalent): agents run in
          // their own isolated worktree, so there is no user to prompt.
          // Pick the most-permissive offered option so the agent doesn't ask
          // again for the same kind of action this session; fall back to
          // whatever's offered if "allow_always" isn't present (some agents
          // may only offer "allow_once").
          const params = req.params as { options: Array<{ optionId: string; kind: string }> };
          const options = Array.isArray(params.options) ? params.options : [];
          const chosen =
            options.find((o) => o.kind === "allow_always") ??
            options.find((o) => o.kind === "allow_once") ??
            options[0];
          if (!chosen) {
            respond({ outcome: { outcome: "cancelled" } });
            return;
          }
          respond({ outcome: { outcome: "selected", optionId: chosen.optionId } });
          return;
        }
        case "fs/read_text_file": {
          const result = await readTextFile(this.spec.cwd, req.params as { path: string; line?: number; limit?: number });
          respond(result);
          return;
        }
        case "fs/write_text_file": {
          const result = await writeTextFile(this.spec.cwd, req.params as { path: string; content: string });
          respond(result);
          return;
        }
        case "terminal/create": {
          const p = req.params as TerminalCreateParams & { sessionId: string };
          respond(this.terminals.create(p));
          return;
        }
        case "terminal/output": {
          const p = req.params as { terminalId: string };
          respond(this.terminals.output(p.terminalId));
          return;
        }
        case "terminal/wait_for_exit": {
          const p = req.params as { terminalId: string };
          respond(await this.terminals.waitForExit(p.terminalId));
          return;
        }
        case "terminal/kill": {
          const p = req.params as { terminalId: string };
          this.terminals.kill(p.terminalId);
          respond({});
          return;
        }
        case "terminal/release": {
          const p = req.params as { terminalId: string };
          this.terminals.release(p.terminalId);
          respond({});
          return;
        }
        default:
          // Unknown agent→client method — surfaced as a JSON-RPC error, never
          // a thrown exception that would kill the connection.
          respondError(`unhandled method: ${req.method}`);
      }
    } catch (err) {
      respondError(String(err));
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeLine({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.writeLine({ jsonrpc: "2.0", method, params });
  }

  private writeLine(obj: unknown): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }
}
