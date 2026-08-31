/**
 * OpenCode CLI plugin.
 * Implements AgentPlugin interface for the `opencode` interactive agent.
 *
 * System-prompt delivery: OPENCODE_CONFIG env — writes a JSON config with
 * `instructions: [<systemPromptFile>]`; opencode reads it as system instructions.
 * Task-prompt delivery: post-launch — pasted to stdin after ready sentinel.
 * Ready signal: waits for "opencode" banner in pane output.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
import { join } from "node:path";
import type { AgentPlugin, LaunchConfig, TurnInput, TurnContext } from "../services/spawn.js";
import { opencodeConfigPathFor, systemPromptPathFor, resolvedContextOf } from "../services/context.js";
import { writeOpenCodeConfig } from "../services/opencodeConfig.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PromptBlock } from "../services/acp/acpTransport.js";
import type { AcpEnrichHook } from "../services/acp/normalize.js";
import type {
  SessionRecord,
  ProjectRecord,
  NormalizedEvent,
  NormalizedEventKind,
  UsageInfo,
} from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decision 2.3 — no opencode-specific enrichment needed beyond the shared mapping. */
const opencodeEnrich: AcpEnrichHook = (_raw, base) => base;

/**
 * ACP-based turn (Decision 2). `opencode acp` is opencode's own native ACP
 * mode (no adapter package, Requirement 7) — spawned directly. System-prompt
 * delivery moves from a per-turn env var to the CONNECTION-spawn env
 * (Phase 3.2) — applied once, at first spawn, instead of re-written every
 * turn; harmless to also re-point it on a later reconnect (matches the
 * legacy plugin's own "harmless to re-point on resumed turns" note).
 * `VST_SPAWN_TOKEN=<session.id>` is also set here — opencode's Option B side
 * channel (the `session.created` hook), harmless under Option A.
 */
async function* runTurnAcp(
  input: TurnInput,
  ctx: TurnContext,
  signal: AbortSignal,
): AsyncIterable<NormalizedEvent> {
  const resolvedCtx = resolvedContextOf(ctx.project, ctx.worktree);
  const configPath = opencodeConfigPathFor(resolvedCtx, ctx.session.id);
  const promptFile = systemPromptPathFor(resolvedCtx, ctx.session.id);
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeOpenCodeConfig(configPath, [promptFile]);
  } catch {
    /* best-effort — spawn still proceeds without instructions */
  }

  const conn = await ctx.getAcpConnection!(
    {
      command: "opencode",
      args: ["acp"],
      cwd: ctx.cwd,
      env: { OPENCODE_CONFIG: configPath, VST_SPAWN_TOKEN: ctx.session.id },
      ...(ctx.onSpawn ? { onSpawn: ctx.onSpawn } : {}),
    },
    opencodeEnrich,
  );
  const sessionId = conn.currentSessionId;
  if (!sessionId) throw new Error("opencode ACP session was not established");

  if (input.isFirstTurn) {
    // Decision 6 Option A capture path (spike 3.0b verdict: coincide) — see
    // claude.ts's identical pattern for the full rationale.
    yield opencodeEvent(ctx.session.id, "session_init", { agentChatId: sessionId });
  }
  const promptBlocks: PromptBlock[] = [{ type: "text", text: input.message }];

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
  if (usage) yield opencodeEvent(ctx.session.id, "usage", { usage, model: usage.model || undefined });
  yield opencodeEvent(ctx.session.id, "result", usage ? { usage, model: usage.model || undefined } : {});
}

function opencodeEvent(
  sessionId: string,
  kind: NormalizedEventKind,
  extra: Partial<NormalizedEvent>,
): NormalizedEvent {
  return {
    id: randomUUID(),
    sessionId,
    ts: new Date().toISOString(),
    provider: "opencode",
    kind,
    ...extra,
  };
}

/**
 * Map ONE opencode `run --format json` line into zero or more NormalizedEvents
 * (Decision 3). Exported for unit testing (3.T1). Malformed lines skipped
 * (Decision 7).
 *
 * Envelope (live-verified 2026-07-14): `{type, timestamp, sessionID, part:{...}}`
 * — the top-level `type` mirrors `part.type` (`text`/`tool`/`reasoning`) with
 * `step_start`/`step_finish` boundaries; the turn ends on
 * `step_finish part.reason=stop`. There is no explicit `init` event, so the
 * `sessionID` on the first line is surfaced as `session_init` (once, tracked via
 * `state.initEmitted`).
 */
export function parseOpencodeStreamLine(
  line: string,
  sessionId: string,
  state: { initEmitted: boolean; toolStarted?: Set<string> },
): NormalizedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return [];
    msg = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const events: NormalizedEvent[] = [];
  const type = msg.type as string | undefined;
  const part = (msg.part ?? {}) as Record<string, unknown>;
  const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined;

  // Surface the harness session id once (no explicit init event).
  if (!state.initEmitted && sessionID) {
    state.initEmitted = true;
    events.push(
      opencodeEvent(sessionId, "session_init", {
        agentChatId: sessionID,
        ...(typeof msg.model === "string" ? { model: msg.model } : {}),
      }),
    );
  }

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);

  const emitUsageAndResult = (): void => {
    const tokens = (part.tokens ?? msg.tokens ?? {}) as Record<string, unknown>;
    const cache = (tokens.cache ?? {}) as Record<string, unknown>;
    const inputTokens = num(tokens.input);
    const outputTokens = num(tokens.output);
    const cacheReadTokens = num(cache.read);
    const cacheCreateTokens = num(cache.write);
    const model = typeof msg.model === "string" ? msg.model : "";
    const hasUsage = inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens > 0;
    if (hasUsage) {
      const usage = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreateTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens,
        ...(typeof part.cost === "number" ? { costUsd: part.cost } : {}),
        model,
      };
      events.push(opencodeEvent(sessionId, "usage", { usage, ...(model ? { model } : {}) }));
      events.push(opencodeEvent(sessionId, "result", { usage, ...(model ? { model } : {}) }));
    } else {
      events.push(opencodeEvent(sessionId, "result", {}));
    }
  };

  if (type === "step_finish") {
    const reason = (part.reason ?? msg.reason) as string | undefined;
    if (reason === "stop") emitUsageAndResult();
    // reason=tool-calls (between steps) → drop
    return events;
  }
  if (type === "step_start") return events;

  const partType = part.type as string | undefined;
  if (partType === "text" && typeof part.text === "string") {
    events.push(opencodeEvent(sessionId, "text", { role: "assistant", text: part.text }));
  } else if (partType === "reasoning" && typeof part.text === "string") {
    events.push(opencodeEvent(sessionId, "thinking", { role: "assistant", text: part.text }));
  } else if (partType === "tool") {
    const st = (part.state ?? {}) as Record<string, unknown>;
    const status = st.status as string | undefined;
    const callId = typeof part.callID === "string" ? part.callID : undefined;
    const toolName = typeof part.tool === "string" ? part.tool : undefined;
    // Emit `tool_use` at most once per tool id (guarded so a terminal part that
    // ALSO synthesizes tool_use never duplicates a prior running/pending one).
    const emitToolUse = (input: unknown): void => {
      if (callId) {
        if (!state.toolStarted) state.toolStarted = new Set();
        if (state.toolStarted.has(callId)) return;
        state.toolStarted.add(callId);
      }
      events.push(
        opencodeEvent(sessionId, "tool_use", {
          role: "assistant",
          ...(toolName ? { toolName } : {}),
          ...(callId ? { toolId: callId } : {}),
          toolInput: input,
        }),
      );
    };
    if (status === "running" || status === "pending") {
      emitToolUse(st.input);
    } else if (status === "completed" || status === "error") {
      // In `run --format json` each tool arrives ONCE already terminal — the
      // running/pending branch never fires — so emit `tool_use` here too (name
      // from `part.tool`, args from `state.input`) BEFORE the result, giving the
      // UI tool card its name + args. Guarded so a real `running` isn't dup'd.
      emitToolUse(st.input);
      const raw = st.output ?? st.error;
      const contentStr =
        typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : undefined;
      events.push(
        opencodeEvent(sessionId, "tool_result", {
          ...(callId ? { toolId: callId } : {}),
          toolResult: {
            ...(contentStr !== undefined ? { content: contentStr } : {}),
            isError: status === "error",
          },
        }),
      );
    }
  }
  return events;
}

/** Bug 7 fix: mirrors `claude.ts`'s `ensureGitignoreEntry` exactly. */
async function ensureGitignoreEntry(gitignorePath: string, entry: string): Promise<void> {
  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (content.split("\n").some((line) => line.trim() === entry)) return;
  const newContent =
    content === "" || content.endsWith("\n")
      ? content + entry + "\n"
      : content + "\n" + entry + "\n";
  await fs.writeFile(gitignorePath, newContent, "utf8");
}

export function createOpencodePlugin(): AgentPlugin {
  return {
    name: "opencode",
    defaultModel: "opencode/big-pickle",
    promptDelivery: "post-launch",

    async listModels() {
      try {
        const { stdout } = await execFileAsync("opencode", ["models"], {
          timeout: 15_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const models = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        return { models };
      } catch (err) {
        console.error("[cli-models] opencode fetch failed:", err);
        return { models: [], error: "Failed to fetch models from CLI. Check that the CLI is installed and authenticated." };
      }
    },
    postSentinelDelayMs: 500,

    getLaunchCommand(cfg: LaunchConfig): string[] {
      if (cfg.model) {
        return ["opencode", "-m", cfg.model];
      }
      return ["opencode"];
    },

    getEnvironment(cfg: LaunchConfig): Record<string, string> {
      // Write (or re-write) the opencode config pointing at the system-prompt file.
      // This runs both on fresh spawn and on restore — so updated AGENTS.md is always picked up.
      const configPath = opencodeConfigPathFor(cfg.ctx, cfg.session.id);
      const promptFile = systemPromptPathFor(cfg.ctx, cfg.session.id);
      try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeOpenCodeConfig(configPath, [promptFile]);
      } catch {
        // best-effort — if data dir doesn't exist yet (before spawnSession writes it),
        // spawnSession will write the prompt file and spawn will re-set the env anyway.
      }
      return { OPENCODE_CONFIG: configPath };
    },

    getReadySignal() {
      return {
        sentinel: "opencode",
        fallbackMs: 10_000,
      };
    },

    composeLaunchPrompt(prompt: {
      systemPrompt: string;
      taskPrompt?: string;
      sessionId: string;
      systemPromptFile: string;
      launchCfg: LaunchConfig;
    }) {
      // System prompt is delivered via OPENCODE_CONFIG env (see getEnvironment).
      // Only the task prompt + verification needle are sent via post-launch paste.
      // postLaunchSubmit=true → spawn.ts sends Enter after the bracketed paste so
      // the TUI actually submits the message (bracketed paste alone preserves
      // newlines but never auto-submits).
      const parts: string[] = [];
      if (prompt.taskPrompt) {
        parts.push(prompt.taskPrompt);
      }
      parts.push(`<!-- VSTPRMT:${prompt.sessionId} -->`);
      return {
        launchArgs: undefined,
        postLaunchInput: parts.length > 0 ? parts.join("\n\n") : undefined,
        postLaunchSubmit: true,
      };
    },

    supportsJson(): boolean {
      return true;
    },

    /** ACP migration (Decision 7/1.4): gates jsonAgent's stop/release semantics. */
    supportsAcp(): boolean {
      return true;
    },

    /**
     * Run ONE JSON-channel turn (Decision 2/3). Drives the persistent ACP
     * connection (`opencode acp`, Decision 1) instead of a per-turn one-shot
     * spawn.
     */
    async *runTurn(
      input: TurnInput,
      ctx: TurnContext,
      signal: AbortSignal,
    ): AsyncIterable<NormalizedEvent> {
      yield* runTurnAcp(input, ctx, signal);
    },

    async setupWorkspaceHooks(worktreePath: string): Promise<void> {
      const pluginDir = join(worktreePath, ".opencode", "plugins");
      const pluginPath = join(pluginDir, "vst-recorder.ts");

      const content =
        [
          'import type { Plugin } from "@opencode-ai/plugin";',
          'import { writeFileSync, mkdirSync } from "node:fs";',
          'import { join } from "node:path";',
          "",
          "export const VstRecorder: Plugin = async ({ directory }) => ({",
          '  "session.created": async (input) => {',
          "    const token = process.env.VST_SPAWN_TOKEN;",
          "    if (!token) return;",
          '    const dir = join(directory, ".vibe-station", "agent-chat-ids");',
          "    mkdirSync(dir, { recursive: true });",
          "    writeFileSync(join(dir, token), input.sessionID);",
          "  },",
          "});",
        ].join("\n") + "\n";

      await fs.mkdir(pluginDir, { recursive: true });

      // Idempotent: skip write if content is unchanged
      try {
        const existing = await fs.readFile(pluginPath, "utf8");
        if (existing !== content) await fs.writeFile(pluginPath, content, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        await fs.writeFile(pluginPath, content, "utf8");
      }

      // OpenCode has a real custom-slash-command mechanism (verified via
      // fable-model research, sqlite-agent-naming Part 02 Phase 3, Decision 3),
      // entirely separate from the plugin API above: a markdown file at
      // `.opencode/commands/<name>.md` becomes `/<name>`, with `$ARGUMENTS`
      // (full trailing text) substitution — a near-exact analog of Claude
      // Code's mechanism.
      const commandsDir = join(worktreePath, ".opencode", "commands");
      const vstCommandPath = join(commandsDir, "vst.md");
      await fs.mkdir(commandsDir, { recursive: true });

      const vstCommand =
        [
          "---",
          "description: Reset, hand off, or rename this vibe-station session/worktree",
          "---",
          "",
          "The user invoked `/vst $ARGUMENTS` — map it to exactly one `vst` CLI",
          "command below and run it as a shell command. Do not run more than one, and",
          "do not improvise flags beyond what's listed here.",
          "",
          "Argument patterns (`$ARGUMENTS` is everything typed after `/vst`):",
          "",
          "- `reset` -> `vst session reset $VST_SESSION`",
          "- `reset --handoff` -> see \"Important — `reset --handoff` writes its own file\" below",
          '- `reset <text>` (any other text after `reset`) -> `vst session reset $VST_SESSION --prompt "<text>"`',
          '- `reset --handoff <text>` -> see "Important — `reset --handoff` writes its own file" below (final command includes both `--handoff-file <path>` and `--prompt "<text>"`)',
          '- `reset --mode <name>` -> `vst session reset $VST_SESSION --mode "<name>"` (switches mode/CLI on reset — combine with other reset flags, e.g. `--mode "<name>" --prompt "<text>"`)',
          "- `handoff` -> `vst session handoff $VST_SESSION`",
          '- `rename <name>` -> `vst session rename $VST_SESSION "<name>"`',
          '- `rename --worktree <name>` -> `vst worktree rename $VST_WORKTREE "<name>"`',
          "",
          "Important — `reset --handoff` writes its own file:",
          "Do NOT pass `--handoff` to the `vst session reset` command. This command is",
          "running from inside the very session being reset, so the daemon has no way",
          "to paste an instruction back into your own pane and wait for a reply — you",
          "are blocked on this shell command, so you'd never see it. Instead: BEFORE",
          "running `vst session reset`, write a concise handoff summary of the current",
          "state, remaining work, and anything the next session should know to any file",
          "of your own choosing, using a normal file-write tool call (not a shell",
          "command). Then run `vst session reset $VST_SESSION --handoff-file <path>`",
          "(with `--prompt \"<text>\"` too if other text followed `--handoff`, but never",
          "`--handoff` itself) — the CLI reads that file locally and sends its contents",
          "as the handoff summary.",
          "",
          "Important — `--worktree` requires a worktree session:",
          "`$VST_WORKTREE` is only set when this session belongs to a worktree; direct",
          "(non-worktree) sessions never have it. Before running the `rename --worktree`",
          "command, check whether `$VST_WORKTREE` is actually set and non-empty. If it",
          "is NOT set, do not run the command — instead tell the user: \"This session",
          "isn't part of a worktree, so there's no worktree to rename.\"",
          "",
          "Important — `reset` ends this session:",
          "Any `reset` variant tears down the CURRENT session process as part of",
          "running the command — this turn effectively never completes from the",
          "user's point of view. Before running a `reset` command, tell the user",
          "something like \"Resetting this session now — you'll see a fresh session",
          "appear.\" Then run the command as your last action. Do not continue the",
          "conversation afterward as if nothing happened.",
          "",
          "`handoff` and `rename` do not end the session — after running those, report",
          "the CLI's output back to the user normally.",
        ].join("\n") + "\n";

      let existingVstCommand: string | null = null;
      try {
        existingVstCommand = await fs.readFile(vstCommandPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (existingVstCommand !== vstCommand) {
        await fs.writeFile(vstCommandPath, vstCommand, "utf8");
      }

      // Bug 7 fix: `.opencode/` was never added to .gitignore, unlike
      // `.claude/` in claude.ts — an agent running `git add -A` would commit
      // it (including the plugin file written above). Matters even more for
      // DIRECT sessions (no worktree isolation): `worktreePath` here is the
      // project's real `absolutePath`, not a throwaway checkout.
      await ensureGitignoreEntry(join(worktreePath, ".gitignore"), ".opencode/").catch(() => {});
    },

    async captureChatId(args: {
      session: SessionRecord;
      project: ProjectRecord;
      cwd: string;
    }): Promise<string | null> {
      // session.created fires when the user's first chat is created, which for the TUI
      // may be after the ready sentinel. Poll for up to 30s; timeout → null → mtime fallback.
      const tokenFile = join(args.cwd, ".vibe-station", "agent-chat-ids", args.session.id);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          const id = (await fs.readFile(tokenFile, "utf8")).trim();
          await fs.unlink(tokenFile).catch(() => {});
          return id || null;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        await sleep(500);
      }
      return null;
    },

    async getRestoreCommand(args: {
      session: { agentChatId?: string };
      project: { id: string };
      cwd: string;
      model?: string;
    }): Promise<string[] | null> {
      if (args.session.agentChatId) {
        const argv = ["opencode"];
        if (args.model) argv.push("-m", args.model);
        argv.push("--session", args.session.agentChatId);
        return argv;
      }
      return null;
    },
  };
}
