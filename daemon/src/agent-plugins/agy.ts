/**
 * Antigravity CLI plugin (`agy` — Google/Codeium "Antigravity" agent, Go binary).
 *
 * Lineage: the binary self-identifies as `antigravity-cli` and is built from the
 * Codeium/Windsurf ("exa"/"cortex"/"cascade") + google3 codebase. Models span
 * Gemini 3.x, Claude 4.6 and GPT-OSS. Conversations are stored per-cwd under
 * `~/.gemini/antigravity-cli/`.
 *
 * TTY mode:
 *   Launch:        `agy --dangerously-skip-permissions --log-file <path> [--model "<name>"]`
 *   Task prompt:   inline via `-i "<prompt>"` (--prompt-interactive: runs the
 *                  prompt then stays interactive — like gemini's -i).
 *   System prompt: agy exposes NO system-prompt flag/env, so it is folded into
 *                  the first `-i` message (like cursor bakes it into message 1).
 *   Chat id:       captured by tailing a PER-SESSION `--log-file` for its
 *                  "Created/Streaming conversation <id>" lines (see the block
 *                  comment above `agyLogPath`) — NOT `last_conversations.json`
 *                  (`cwd → latest conversation_id`), which is only flushed on
 *                  a graceful `/quit` and is otherwise stale/wrong for any
 *                  session vibe-station kills via `tmux kill-session`
 *                  (verified live — this was a real, shipped-then-reverted
 *                  bug; see the chat-id capture block comment for the full
 *                  investigation trail). That file is kept ONLY as a final
 *                  fallback in `getRestoreCommand` below.
 *   Resume:        `agy --conversation <id>` (verified; `--continue`/`-c` = most recent).
 *   Known gap:     a brand-new (never-before-trusted) cwd shows an
 *                  interactive "Do you trust this folder?" prompt that
 *                  `--dangerously-skip-permissions` does NOT bypass (verified
 *                  live) — the task prompt never runs until something sends
 *                  Enter. Not fixed here; `captureChatId` degrades safely
 *                  (times out to null) and `refreshChatIdOnToggle` self-heals
 *                  once the user gets past the prompt and actually converses.
 *
 * JSON mode (verified live, agy 1.1.2):
 *   agy's `--print`/`-p`/`--prompt` is a STRING flag whose value IS the prompt.
 *   `agy --print=<msg> --output-format json [--model m] [--conversation <id>]
 *    --dangerously-skip-permissions` prints ONE final JSON envelope on stdout:
 *      { conversation_id, status:"SUCCESS"|"ERROR", response, error?,
 *        duration_seconds, num_turns,
 *        usage:{ input_tokens, output_tokens, thinking_tokens, total_tokens } }
 *   Unlike claude/cursor/opencode, agy does NOT stream per-event NDJSON — there
 *   are no live thinking/tool_use/tool_result events in print JSON. The whole
 *   turn resolves to a single result object at process exit, which the parser
 *   fans out into session_init + text + usage + result (+ error). Context resume
 *   via `--conversation` is verified stable (num_turns increments, recall works).
 *   agy reports no cache tokens and no cost, and the envelope carries no model
 *   name, so `model` is threaded in from the requested model.
 */

import { promises as fs, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentPlugin, LaunchConfig, TurnInput, TurnContext } from "../services/spawn.js";
import { sq } from "../services/shell.js";
import type {
  SessionRecord,
  ProjectRecord,
  NormalizedEvent,
  NormalizedEventKind,
} from "../types.js";

function agyEvent(
  sessionId: string,
  kind: NormalizedEventKind,
  extra: Partial<NormalizedEvent>,
): NormalizedEvent {
  return {
    id: randomUUID(),
    sessionId,
    ts: new Date().toISOString(),
    provider: "agy",
    kind,
    ...extra,
  };
}

/**
 * Parse ONE agy `--output-format json` line — agy emits a SINGLE final result
 * envelope (not streamed NDJSON), so this maps that one object into the full
 * event sequence: session_init → text → usage → result (→ error). Exported for
 * unit testing (the plugin's private normalization boundary — Decision 3). The
 * envelope carries no model name, so `fallbackModel` (the requested model) fills
 * `usage.model`/`session_init.model`. Malformed / non-JSON lines are skipped
 * (Decision 7) — agy logs go to stderr/log-file, but tolerate any stray stdout.
 */
export function parseAgyResultLine(
  line: string,
  sessionId: string,
  fallbackModel?: string,
): NormalizedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return [];
    msg = parsed as Record<string, unknown>;
  } catch {
    return []; // malformed — skip + tolerate
  }

  // agy's result envelope is identified by conversation_id + status. Anything
  // else on stdout (unexpected) is not our result line → skip.
  const conversationId = typeof msg.conversation_id === "string" ? msg.conversation_id : undefined;
  const status = typeof msg.status === "string" ? msg.status : undefined;
  if (!conversationId && !status) return [];

  const events: NormalizedEvent[] = [];
  const model = fallbackModel && fallbackModel.length ? fallbackModel : "";

  // session_init — surface the conversation id so the core persists it as the
  // agentChatId (reused via `--conversation` on the next turn, Decision 10).
  events.push(
    agyEvent(sessionId, "session_init", {
      ...(conversationId ? { agentChatId: conversationId } : {}),
      ...(model ? { model } : {}),
    }),
  );

  // Assistant answer.
  const response = typeof msg.response === "string" ? msg.response : "";
  if (response) {
    events.push(agyEvent(sessionId, "text", { role: "assistant", text: response }));
  }

  // Usage — agy reports no cache tokens and no cost; `total_tokens` is provided
  // (input + output + thinking). thinking_tokens has no slot in UsageInfo (it is
  // already summed into total_tokens by agy).
  const usageRaw = (msg.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const inputTokens = num(usageRaw.input_tokens);
  const outputTokens = num(usageRaw.output_tokens);
  const totalTokens = num(usageRaw.total_tokens) || inputTokens + outputTokens;
  const usage = {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    totalTokens,
    model,
  };
  events.push(agyEvent(sessionId, "usage", { usage, ...(model ? { model } : {}) }));

  // Result — turn finished. On ERROR, carry the error text on the result too.
  const errorText = typeof msg.error === "string" ? msg.error : undefined;
  const isError = status === "ERROR" || errorText !== undefined;
  events.push(
    agyEvent(sessionId, "result", {
      usage,
      ...(model ? { model } : {}),
      ...(isError && errorText ? { text: errorText } : {}),
    }),
  );

  // A failed turn emits a typed `error` event alongside `result` (like claude /
  // cursor) so the UI can distinguish it from a clean turn.
  if (isError) {
    events.push(agyEvent(sessionId, "error", { text: errorText ?? "agy turn failed" }));
  }

  return events;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Path to agy's per-cwd conversation index (`cwd → latest conversation_id`). */
function agyLastConversationsPath(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "cache", "last_conversations.json");
}

/**
 * Read the latest agy conversation id for a given workspace cwd (best-effort).
 * NOTE: only reliable as a LAST-RESORT fallback (`getRestoreCommand` below) —
 * see the chat-id capture block comment for why this cannot be trusted as a
 * primary signal.
 */
async function readLatestAgyConversationId(cwd: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(agyLastConversationsPath(), "utf8");
    const map = JSON.parse(raw) as Record<string, unknown>;
    const id = map[cwd];
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Chat-id capture (serious bug, two design iterations — see the
 * json-mode-followups investigation):
 *
 * Iteration 1 (WRONG, do not resurrect): read `last_conversations.json`
 * (`cwd → latest conversation_id`, no session identity) once, right after
 * spawn. Unsafe because a premature read in a reused cwd silently returns a
 * DIFFERENT, unrelated conversation's id instead of failing.
 *
 * Iteration 2 (ALSO WRONG): baseline-diff-poll the same cache file. This
 * assumed the cache eventually reflects the truth if you wait/compare
 * against a snapshot. False: EMPIRICALLY VERIFIED (spawn an interactive
 * `agy` session, let it fully answer, inspect the cache — no entry) that
 * `last_conversations.json` is only written on a GRACEFUL exit (`/quit`) in
 * TTY mode. vibe-station's teardown (`killSession`, `tmux.ts`) sends SIGHUP,
 * never a graceful quit — so the cache for a killed session's cwd never
 * updates, and any code trusting it (however carefully diffed) just adopts
 * whatever STALE entry was already sitting there from a previous, unrelated
 * conversation in the same reused cwd. This is how iteration 2 reproduced
 * the exact original bug through a different code path.
 *
 * Iteration 3 (current): agy accepts `--log-file <path>` and logs
 * `Created conversation <id>` once at conversation start and
 * `Streaming conversation <id>` on every turn thereafter (including
 * resumed ones) — VERIFIED LIVE, independent of graceful vs. killed exit,
 * because the id is logged as the conversation happens, not flushed on
 * shutdown. Pointing `--log-file` at a PER-SESSION path (keyed by our own
 * session id, not cwd) makes this a session-scoped signal with no
 * cross-session ambiguity and no baseline/diffing needed at all: any match
 * found in THIS session's own log file is unambiguously this session's own
 * conversation.
 */
function agyLogPath(sessionId: string): string {
  return join(homedir(), ".vibe-station", "agy-logs", `${sessionId}.log`);
}

/** Regex-match order matters: prefer the LAST "Streaming" line (fires on
 *  every turn, so it reflects the CURRENT conversation even after a resume)
 *  and only fall back to the LAST "Created" line (fires once, at the very
 *  first turn) when no "Streaming" line exists yet. Line text is agy's own
 *  internal glog output, not a documented contract — kept intentionally
 *  tolerant (`[\da-f-]{36}`, no anchors) against minor format drift. */
async function parseLastConversationIdFromLog(logPath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(logPath, "utf8");
  } catch {
    return null;
  }
  const lastMatch = (re: RegExp): string | null => {
    let last: string | null = null;
    for (const m of content.matchAll(re)) {
      const id = m[1];
      if (id) last = id;
    }
    return last;
  };
  return (
    lastMatch(/Streaming conversation ([\da-f-]{36})/g) ??
    lastMatch(/Created conversation ([\da-f-]{36})/g)
  );
}

export const CHAT_ID_POLL_TIMEOUT_MS = 30_000;
export const CHAT_ID_POLL_INTERVAL_MS = 500;

/**
 * Poll the session's `--log-file` until a conversation id appears, or the
 * timeout elapses (→ null). Extracted as a standalone function (rather than
 * inlined in `captureChatId`) so tests can drive it with a short real
 * timeout/interval instead of fighting fake timers around a real internal
 * async loop + real fs I/O — vitest's fake timers don't reliably virtualize
 * that combination, and a real 30s wait per test is not acceptable.
 * Production call sites always use the exported defaults.
 */
export async function pollLogForConversationId(
  logPath: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? CHAT_ID_POLL_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? CHAT_ID_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await parseLastConversationIdFromLog(logPath);
    if (id) return id;
    await sleep(intervalMs);
  }
  return null;
}

// Exact display names as printed by `agy models` (must match for --model to
// resolve — print mode hard-fails on an unresolvable model).
const AGY_MODELS = [
  "Gemini 3.5 Flash (Low)",
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (High)",
  "Gemini 3.1 Pro (Low)",
  "Gemini 3.1 Pro (High)",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
  "GPT-OSS 120B (Medium)",
] as const;

const AGY_DEFAULT_MODEL = "Gemini 3.1 Pro (High)";

export function createAgyPlugin(): AgentPlugin {
  return {
    name: "agy",
    defaultModel: AGY_DEFAULT_MODEL,
    promptDelivery: "inline",

    async listModels() {
      // `agy models` prints these display names; keep a curated static list so
      // model discovery never depends on a live CLI call.
      return { models: [...AGY_MODELS] };
    },

    getLaunchCommand(cfg: LaunchConfig): string[] {
      const argv = ["agy", "--dangerously-skip-permissions"];
      if (cfg.model) argv.push("--model", cfg.model);
      if (cfg.session.agentChatId) argv.push("--conversation", cfg.session.agentChatId);
      // Session-scoped log so captureChatId/refreshChatIdOnToggle can read
      // this session's OWN "Created/Streaming conversation <id>" lines —
      // see the block comment above `agyLogPath`. Directory is created
      // synchronously since getLaunchCommand itself must stay synchronous
      // (AgentPlugin interface, spawn.ts).
      const logPath = agyLogPath(cfg.session.id);
      mkdirSync(dirname(logPath), { recursive: true });
      argv.push("--log-file", logPath);
      return argv;
    },

    getEnvironment(): Record<string, string> {
      return {};
    },

    getReadySignal() {
      // agy is a Charm/Bubbletea TUI that negotiates terminal capabilities
      // before painting; there is no stable printed sentinel we can rely on
      // across terminals, so gate purely on a fallback delay (the spawn layer
      // just proceeds after this — the -i prompt is delivered as a launch arg,
      // not a post-ready paste, so exact ready timing is non-critical).
      return { fallbackMs: 12_000 };
    },

    composeLaunchPrompt(prompt: {
      systemPrompt: string;
      taskPrompt?: string;
      sessionId: string;
      systemPromptFile: string;
      launchCfg: LaunchConfig;
    }) {
      // Deliver the task prompt inline via -i so agy runs it on startup and stays
      // interactive. To avoid command-line / tmux argument length limits for very
      // large prompts, write the combined prompt to a file and read it using $(cat)
      // inside a shell wrapper.
      if (prompt.taskPrompt) {
        const combined = prompt.systemPrompt
          ? `${prompt.systemPrompt}\n\n${prompt.taskPrompt}`
          : prompt.taskPrompt;

        const combinedPromptFile = join(dirname(prompt.systemPromptFile), "combined_prompt.txt");
        writeFileSync(combinedPromptFile, combined, "utf8");

        let shellLine = `agy --dangerously-skip-permissions`;
        if (prompt.launchCfg.model) {
          shellLine += ` --model ${sq(prompt.launchCfg.model)}`;
        }
        if (prompt.launchCfg.session.agentChatId) {
          shellLine += ` --conversation ${sq(prompt.launchCfg.session.agentChatId)}`;
        }
        const logPath = agyLogPath(prompt.sessionId);
        mkdirSync(dirname(logPath), { recursive: true });
        shellLine += ` --log-file ${sq(logPath)}`;
        shellLine += ` -i "$(cat ${sq(combinedPromptFile)})"`;

        return {
          useShell: true as const,
          shellLine,
          launchArgs: undefined,
          postLaunchInput: undefined,
        };
      }
      return {};
    },

    // No provideChatId: agy has no pre-mint equivalent (unlike cursor's
    // `create-chat`), and the log-file design needs no pre-spawn baseline —
    // the log itself is the session-scoped source of truth (see block
    // comment above `agyLogPath`).

    async captureChatId(args: { session: SessionRecord }): Promise<string | null> {
      // Poll THIS session's own log file (written via --log-file, wired in
      // getLaunchCommand) for its "Created/Streaming conversation <id>"
      // line. Session-scoped by construction — no cross-session ambiguity,
      // no baseline/diffing needed.
      return pollLogForConversationId(agyLogPath(args.session.id));
    },

    /**
     * Self-heal on tty→json toggle (see the block comment above
     * `agyLogPath`). No poll needed here — by the time a user toggles a
     * session they've been actively using, its log file already has real
     * conversation lines regardless of how the terminal was just torn down
     * (killSession never lets agy flush `last_conversations.json`, but the
     * log lines were written live, during the conversation, not at exit).
     */
    async refreshChatIdOnToggle(args: { session: SessionRecord }): Promise<string | null> {
      return parseLastConversationIdFromLog(agyLogPath(args.session.id));
    },

    supportsJson(): boolean {
      return true;
    },

    /**
     * Run ONE JSON-channel turn (Decision 2/3). Spawns `agy --print=<msg>
     * --output-format json` and yields NormalizedEvents once the single result
     * envelope arrives (agy does not stream). Own process group (detached) so a
     * stuck turn is group-killed and never orphaned (Decision 13).
     *
     * The message is passed as the VALUE of `--print` (agy's `--print` is a
     * string flag, NOT a boolean — a bare `--print` with the message on stdin or
     * as a `--`-separated positional is mis-parsed into the prompt text). The
     * `--print=<msg>` attached form is safe for any message (even one starting
     * with `--`). System prompt is folded into the first turn's message; resumed
     * turns pass `--conversation <chatId>`.
     */
    async *runTurn(
      input: TurnInput,
      ctx: TurnContext,
      signal: AbortSignal,
    ): AsyncIterable<NormalizedEvent> {
      const sessionId = ctx.session.id;

      let message = input.message;
      if (input.isFirstTurn) {
        const systemPrompt = await fs.readFile(ctx.systemPromptFile, "utf8").catch(() => "");
        if (systemPrompt) message = `${systemPrompt}\n\n${message}`;
      }

      const args = [
        `--print=${message}`,
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
      ];
      if (ctx.model) args.push("--model", ctx.model);
      if (ctx.chatId) args.push("--conversation", ctx.chatId);

      const child = spawn("agy", args, {
        cwd: ctx.cwd,
        detached: true, // own process group for group-kill on abort
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (child.pid) ctx.onSpawn?.(child.pid);

      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });

      const onAbort = (): void => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already dead */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      const exitPromise = new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 0));
      });

      try {
        const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        for await (const line of rl) {
          for (const ev of parseAgyResultLine(line, sessionId, ctx.model)) {
            yield ev;
          }
        }
        const code = await exitPromise;
        // A non-zero exit with no JSON envelope (e.g. model-resolution hard-fail)
        // surfaces as a thrown error the core converts into a synthetic error
        // event (Decision 7). agy in-turn failures instead exit 0 with
        // status:ERROR and are handled by the parser above.
        if (code !== 0 && !signal.aborted) {
          throw new Error(`agy exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (!child.killed && child.exitCode === null) {
          try {
            if (child.pid) process.kill(-child.pid, "SIGTERM");
          } catch {
            /* ignore */
          }
        }
      }
    },

    async getRestoreCommand(args: {
      session: SessionRecord;
      project: ProjectRecord;
      cwd: string;
      model?: string;
    }): Promise<string[] | null> {
      const { session, cwd, model } = args;
      const id = session.agentChatId ?? (await readLatestAgyConversationId(cwd));
      if (!id) return null;
      const argv = ["agy", "--conversation", id, "--dangerously-skip-permissions"];
      if (model) argv.push("--model", model);
      return argv;
    },
  };
}
