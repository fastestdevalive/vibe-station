/**
 * OpenCode CLI plugin.
 * Implements AgentPlugin interface for the `opencode` interactive agent.
 *
 * System-prompt delivery: OPENCODE_CONFIG env — writes a JSON config with
 * `instructions: [<systemPromptFile>]`; opencode reads it as system instructions.
 * Task-prompt delivery: post-launch — pasted to stdin after ready sentinel.
 * Ready signal: waits for "opencode" banner in pane output.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const execFileAsync = promisify(execFile);
import { join } from "node:path";
import type { AgentPlugin, LaunchConfig, TurnInput, TurnContext } from "../services/spawn.js";
import { opencodeConfigPathFor, systemPromptPathFor, resolvedContextOf } from "../services/context.js";
import { writeOpenCodeConfig } from "../services/opencodeConfig.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  SessionRecord,
  ProjectRecord,
  NormalizedEvent,
  NormalizedEventKind,
} from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    /**
     * Run ONE JSON-channel turn (Decision 2/3): `opencode run <msg> --format
     * json [-m model] [--session <id>]`. The system prompt is delivered via the
     * `OPENCODE_CONFIG` env → a JSON config listing the system-prompt file as
     * `instructions` (applied on turn 1; harmless to re-point on resumed turns).
     */
    async *runTurn(
      input: TurnInput,
      ctx: TurnContext,
      signal: AbortSignal,
    ): AsyncIterable<NormalizedEvent> {
      const sessionId = ctx.session.id;

      // Resolve config + system-prompt paths for worktree OR direct sessions —
      // routed through the shared *For(ctx, …) helpers (not manual ctx.worktree
      // branching) so this can't drift into the "fabricated worktree resolves to
      // a nonexistent directory" bug class the context refactor eliminated.
      const resolvedCtx = resolvedContextOf(ctx.project, ctx.worktree);
      const configPath = opencodeConfigPathFor(resolvedCtx, sessionId);
      const promptFile = systemPromptPathFor(resolvedCtx, sessionId);
      try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeOpenCodeConfig(configPath, [promptFile]);
      } catch {
        /* best-effort — spawn still proceeds without instructions */
      }

      const args = ["run", input.message, "--format", "json"];
      if (ctx.model && ctx.model !== "auto") args.push("-m", ctx.model);
      if (ctx.chatId) args.push("--session", ctx.chatId);

      const child = spawn("opencode", args, {
        cwd: ctx.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OPENCODE_CONFIG: configPath },
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

      const state = { initEmitted: false };
      try {
        const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        for await (const line of rl) {
          for (const ev of parseOpencodeStreamLine(line, sessionId, state)) {
            yield ev;
          }
        }
        const code = await exitPromise;
        if (code !== 0 && !signal.aborted) {
          throw new Error(`opencode exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
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
        if (existing === content) return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      await fs.writeFile(pluginPath, content, "utf8");
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
