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
 * JSON mode (verified live, agy 1.1.12 — switched from `--output-format json`
 * to `--output-format stream-json`; see json-agy-stream-json investigation):
 *   agy's `--print`/`-p`/`--prompt` is a STRING flag whose value IS the prompt.
 *   `agy --print=<msg> --output-format stream-json [--model m]
 *    [--conversation <id>] --dangerously-skip-permissions` emits real per-step
 *    NDJSON on stdout, one JSON object per line:
 *      {"event":"init", conversation_id, init:{cwd,tools,permission_mode}}
 *      {"event":"step_update", step_update:{conversation_id, step_index,
 *        state:"ACTIVE"|"DONE", step_type, text_delta?, tool_name?, tool_info?,
 *        duration_seconds?, usage?}}
 *      {"event":"result", result:{conversation_id, status:"SUCCESS"|"ERROR",
 *        response, error?, duration_seconds, num_turns, usage}}
 *   `init` is always first EXCEPT on an immediate hard-fail (e.g. unresolvable
 *   `--model`), where the stream is just one `result` (status:"ERROR", no
 *   conversation_id). `step_type:"agent_response"` streams the answer as
 *   `text_delta` chunks (ACTIVE, then a final chunk + usage on DONE);
 *   `step_type:"tool"` carries the call (`tool_name`/`tool_info.parameters`) on
 *   ACTIVE and the same + `tool_info.output`/`.error` on DONE. Human-gate tools
 *   (`ask_question`/`ask_permission`) auto-skip in headless/print mode and
 *   surface as an anonymous `step_type:"unknown"` with no `tool_name` — not a
 *   detectable gate signal (separate, already-answered question). Other
 *   `step_type`s (`user_input`, `unknown`, `checkpoint`, `error_message`) carry
 *   no renderable payload in any live capture and are dropped. `conversation_id`
 *   is top-level on `init` but nested inside `step_update`/`result`. Context
 *   resume via `--conversation` is verified stable (num_turns increments,
 *   recall works). agy reports no cache tokens and no cost, and no event
 *   carries a model name, so `model` is threaded in from the requested model.
 */

import { promises as fs, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentPlugin, LaunchConfig, TurnInput, TurnContext } from "../services/spawn.js";
import { sq } from "../services/shell.js";
import type { PromptBlock } from "../services/acp/acpTransport.js";
import type { AcpEnrichHook } from "../services/acp/normalize.js";
import {
  readAgyAcpSessionConversationId,
  readLatestAgyConversationId,
} from "./native-chat-id/agy.js";
import type {
  SessionRecord,
  ProjectRecord,
  NormalizedEvent,
  NormalizedEventKind,
  UsageInfo,
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

/** Per-turn mutable state threaded through `parseAgyStreamLine` calls in
 *  `runTurn`'s readline loop — mirrors opencode's `toolStarted` guard
 *  (`opencode.ts`'s `parseOpencodeStreamLine`). Must be a FRESH object per
 *  turn (step_index resets every turn). */
export interface AgyStreamState {
  toolStarted: Set<string>;
}

export function createAgyStreamState(): AgyStreamState {
  return { toolStarted: new Set() };
}

/**
 * Parse ONE agy `--output-format stream-json` line into zero or more
 * NormalizedEvents. Exported for unit testing (the plugin's private
 * normalization boundary — Decision 3). agy streams real per-step NDJSON
 * (`init` → many `step_update` → `result`, see the file-header doc comment for
 * the full shape) — this is NOT a single-envelope parser (that was the old
 * `--output-format json` behavior, retired in the stream-json migration).
 * `fallbackModel` (the requested model) fills `model` on `session_init`/
 * `usage`/`result` since no agy event ever carries a model name. Malformed /
 * non-JSON lines are skipped (Decision 7) — agy logs go to stderr/log-file,
 * but tolerate any stray stdout.
 */
export function parseAgyStreamLine(
  line: string,
  sessionId: string,
  state: AgyStreamState,
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

  const event = typeof msg.event === "string" ? msg.event : undefined;
  const model = fallbackModel && fallbackModel.length ? fallbackModel : "";
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);

  if (event === "init") {
    const conversationId = typeof msg.conversation_id === "string" ? msg.conversation_id : undefined;
    return [
      agyEvent(sessionId, "session_init", {
        ...(conversationId ? { agentChatId: conversationId } : {}),
        ...(model ? { model } : {}),
      }),
    ];
  }

  if (event === "step_update") {
    const step = (msg.step_update ?? {}) as Record<string, unknown>;
    const stepType = typeof step.step_type === "string" ? step.step_type : undefined;
    const stepState = typeof step.state === "string" ? step.state : undefined;
    const events: NormalizedEvent[] = [];

    if (stepType === "agent_response") {
      const textDelta = typeof step.text_delta === "string" ? step.text_delta : "";
      if (textDelta) {
        events.push(agyEvent(sessionId, "text", { role: "assistant", text: textDelta }));
      }
      return events;
    }

    if (stepType === "tool") {
      // No separate tool-call id in agy's protocol — step_index is unique per
      // turn and stable across a tool's ACTIVE→DONE pair.
      const toolId = typeof step.step_index === "number" ? String(step.step_index) : undefined;
      const toolInfo = (step.tool_info ?? {}) as Record<string, unknown>;
      const toolName = typeof step.tool_name === "string" ? step.tool_name : undefined;
      if (toolId && !state.toolStarted.has(toolId)) {
        state.toolStarted.add(toolId);
        events.push(
          agyEvent(sessionId, "tool_use", {
            role: "assistant",
            ...(toolName ? { toolName } : {}),
            toolId,
            toolInput: toolInfo.parameters,
          }),
        );
      }
      if (stepState === "DONE") {
        const raw = toolInfo.output ?? toolInfo.error;
        const contentStr =
          typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : undefined;
        events.push(
          agyEvent(sessionId, "tool_result", {
            ...(toolId ? { toolId } : {}),
            toolResult: {
              ...(contentStr !== undefined ? { content: contentStr } : {}),
              isError: toolInfo.error !== undefined,
            },
          }),
        );
      }
      return events;
    }

    // user_input / unknown / checkpoint / error_message (and any future
    // step_type) — no renderable payload observed live; drop (Decision 4).
    return events;
  }

  if (event === "result") {
    const result = (msg.result ?? {}) as Record<string, unknown>;
    const status = typeof result.status === "string" ? result.status : undefined;
    const events: NormalizedEvent[] = [];

    // Usage — agy reports no cache tokens and no cost; `total_tokens` is
    // provided (input + output + thinking). thinking_tokens has no slot in
    // UsageInfo (already summed into total_tokens by agy).
    const usageRaw = (result.usage ?? {}) as Record<string, unknown>;
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
    const errorText = typeof result.error === "string" ? result.error : undefined;
    const isError = status === "ERROR" || errorText !== undefined;
    events.push(
      agyEvent(sessionId, "result", {
        usage,
        ...(model ? { model } : {}),
        ...(isError && errorText ? { text: errorText } : {}),
      }),
    );

    // A failed turn emits a typed `error` event alongside `result` (like claude
    // / cursor) so the UI can distinguish it from a clean turn.
    if (isError) {
      events.push(agyEvent(sessionId, "error", { text: errorText ?? "agy turn failed" }));
    }

    return events;
  }

  // Unrecognized top-level event — tolerate any stray/future shape.
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// --- ACP migration (Decision 2/6, Phase 4 — spike-gated) ---
//
// IMPORTANT / deviation flagged for human review: unlike claude (an
// npm-installable, Anthropic-affiliated adapter package) and cursor/opencode
// (first-party native ACP subcommands on binaries already required by this
// plugin), agy's ONLY available ACP adapter as of this implementation is the
// THIRD-PARTY, single-maintainer npm package `antigravity-acp` (published by
// an individual GitHub user, not Google/Zed/agentclientprotocol), and it is
// built on Bun — its own `bin` entries are literal `.ts` files, runnable only
// via `bun`/`bunx`, NOT via plain `node`. This introduces a NEW system-level
// runtime dependency (`bun`) beyond everything else this plan needs (which is
// npm-installable and node-executable). Phase 4.1's spike (initialize +
// session/new against a real, already-authenticated `agy`) completed without
// hanging on this machine, so this plugin proceeds per the plan's own
// "on success, continue to 4.2" instruction — but the supply-chain trust and
// new-runtime-dependency questions this raises are NOT this plan's to settle
// unilaterally; see the final report / Risk 1 update for the explicit
// call-out. `bunx antigravity-acp@<pinned version>` is used directly (NOT
// vendored via `cli/package.json`, since it is not a node-resolvable
// dependency) — the exact version is pinned on the command line for the same
// "don't silently float" reason Phase 1.7 pins npm packages.
const ANTIGRAVITY_ACP_PACKAGE = "antigravity-acp@1.1.0";

/** Resolve the user's own `agy` binary, passed to the adapter via `AGY_BIN` (its own escape hatch — it otherwise tries to download a release binary itself). */
function resolveAgyBinary(): string {
  try {
    return execFileSync("which", ["agy"], { encoding: "utf8" }).trim() || "agy";
  } catch {
    return "agy";
  }
}

/** Decision 2.3 — no agy-specific enrichment needed beyond the shared mapping. */
const agyEnrich: AcpEnrichHook = (_raw, base) => base;

/**
 * ACP-based turn (Decision 2). Drives `bunx antigravity-acp@<pinned>` (spawned
 * once per session, Decision 1) instead of a per-turn one-shot `agy` spawn.
 * Phase 4.3's 20s connect/initialize timeout is `AcpConnection`'s existing
 * `initializeTimeoutMs`, not a new mechanism.
 */
async function* runTurnAcp(
  input: TurnInput,
  ctx: TurnContext,
  signal: AbortSignal,
): AsyncIterable<NormalizedEvent> {
  let conn;
  try {
    conn = await ctx.getAcpConnection!(
      {
        command: "bunx",
        args: [ANTIGRAVITY_ACP_PACKAGE],
        cwd: ctx.cwd,
        env: { AGY_BIN: resolveAgyBinary() },
        initializeTimeoutMs: 20_000, // Phase 4.3 — never lets the turn hang indefinitely
        ...(ctx.onSpawn ? { onSpawn: ctx.onSpawn } : {}),
      },
      agyEnrich,
    );
  } catch (err) {
    // Phase 4.3: a specific, human-readable message for the connect/
    // initialize timeout (or a spawn failure) — the core (jsonAgent.ts's
    // runOneTurn catch block, Decision 7) converts this thrown error into a
    // synthetic `error` NormalizedEvent exactly as any other transport
    // failure, so the turn fails fast instead of hanging.
    throw new Error(`Antigravity ACP unavailable: ${String(err)}`);
  }
  const sessionId = conn.currentSessionId;
  if (!sessionId) throw new Error("agy ACP session was not established");

  // agy spike (4.1b) verdict: Option B — the ACP session id does not
  // round-trip through `agy --conversation`. Do NOT surface it as
  // `agentChatId`; `captureNativeChatId` below is the source of truth.
  let message = input.message;
  if (input.isFirstTurn) {
    const systemPrompt = await fs.readFile(ctx.systemPromptFile, "utf8").catch(() => "");
    if (systemPrompt) message = `${systemPrompt}\n\n${message}`;
  }
  const promptBlocks: PromptBlock[] = [{ type: "text", text: message }];

  const { updates, result } = conn.sendPrompt(sessionId, promptBlocks, signal);
  for await (const ev of updates) yield ev;

  let usageRaw: Record<string, unknown> | undefined;
  try {
    const r = await result;
    usageRaw = (r as unknown as { usage?: Record<string, unknown> }).usage;
  } catch (err) {
    if (signal.aborted) return;
    throw err;
  }

  const usage: UsageInfo | undefined = usageRaw
    ? (() => {
        const num = (v: unknown): number => (typeof v === "number" ? v : 0);
        const inputTokens = num(usageRaw!.inputTokens);
        const outputTokens = num(usageRaw!.outputTokens);
        return {
          inputTokens,
          outputTokens,
          cacheReadTokens: num(usageRaw!.cachedReadTokens),
          cacheCreateTokens: num(usageRaw!.cachedWriteTokens),
          totalTokens: num(usageRaw!.totalTokens) || inputTokens + outputTokens,
          model: ctx.model ?? "",
        };
      })()
    : undefined;
  if (usage) yield agyEvent(ctx.session.id, "usage", { usage, model: usage.model || undefined });
  yield agyEvent(ctx.session.id, "result", usage ? { usage, model: usage.model || undefined } : {});
}

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
     * ACP migration (Decision 7/1.4/4.1): true because Phase 4.1's live spike
     * (real `agy` + `bunx antigravity-acp`) completed `initialize` +
     * `session/new` without hanging on this machine. See the block comment
     * above `ANTIGRAVITY_ACP_PACKAGE` for the third-party-adapter /
     * new-`bun`-dependency caveat this verdict carries — flagged for human
     * review, not silently accepted.
     */
    supportsAcp(): boolean {
      return true;
    },

    /**
     * Run ONE JSON-channel turn (Decision 2/3). Drives the persistent ACP
     * connection (Decision 1) instead of a per-turn one-shot spawn.
     */
    async *runTurn(
      input: TurnInput,
      ctx: TurnContext,
      signal: AbortSignal,
    ): AsyncIterable<NormalizedEvent> {
      yield* runTurnAcp(input, ctx, signal);
    },

    /**
     * Decision 6 Option B (spike 4.1b verdict: diverge — ACP `session/new` id
     * does not round-trip through `agy --conversation`), REVISED after live
     * re-verification (2026-08-30): prefer the `antigravity-acp` adapter's own
     * `~/.agy-acp/sessions.json` (`readAgyAcpSessionConversationId`, keyed by
     * the exact ACP `acpSessionId` — no cross-session ambiguity at all), and
     * fall back to the cwd-keyed `readLatestAgyConversationId(cwd)` only if
     * that adapter-state file is missing/stale (e.g. an older adapter version
     * without this store, or the file was cleared). See the block comment
     * above `readAgyAcpSessionConversationId` for the live-verified mechanism
     * and resume proof.
     */
    async captureNativeChatId(args: {
      session: SessionRecord;
      project: ProjectRecord;
      cwd: string;
      acpSessionId: string;
    }): Promise<string | null> {
      return (
        args.session.agentChatId ??
        (await readAgyAcpSessionConversationId(args.acpSessionId)) ??
        (await readLatestAgyConversationId(args.cwd))
      );
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
