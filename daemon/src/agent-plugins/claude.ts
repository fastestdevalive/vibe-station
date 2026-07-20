/**
 * Claude Code CLI plugin.
 * Implements AgentPlugin interface for the `claude` command-line agent.
 *
 * Delivery: inline — system and task prompts are passed via CLI flags.
 * Ready signal: waits for interactive prompt sentinel ("> ").
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentPlugin, LaunchConfig, TurnInput, TurnContext } from "../services/spawn.js";
import { sq } from "../services/shell.js";
import { findLatestChatUuid } from "./claudeRestore.js";
import type {
  SessionRecord,
  ProjectRecord,
  NormalizedEvent,
  NormalizedEventKind,
} from "../types.js";

/** Build a claude-provider NormalizedEvent, stamping id/ts/provider. */
function claudeEvent(
  sessionId: string,
  kind: NormalizedEventKind,
  extra: Partial<NormalizedEvent>,
): NormalizedEvent {
  return {
    id: randomUUID(),
    sessionId,
    ts: new Date().toISOString(),
    provider: "claude",
    kind,
    ...extra,
  };
}

/**
 * Map ONE claude `stream-json` line into zero or more NormalizedEvents.
 * Exported for unit testing (2.T1); it is the plugin's private normalization
 * boundary — the core never calls JSON.parse itself (Decision 3).
 *
 * `fallbackModel` is the primary/requested model, used for the `result`/`usage`
 * model when the result line carries none. We deliberately do NOT fall back to
 * `Object.keys(modelUsage)[0]`: `modelUsage` enumerates every model touched this
 * turn (including haiku subagents), and its first key is often a subagent — not
 * the model that actually answered — which then drifts into the status bar.
 *
 * Malformed / non-JSON lines are skipped (Decision 7): harnesses interleave
 * non-JSON logs on stdout, and one bad line must not abort a turn.
 */
export function parseClaudeStreamLine(
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

  const events: NormalizedEvent[] = [];
  const type = msg.type as string | undefined;

  if (type === "system" && msg.subtype === "init") {
    events.push(
      claudeEvent(sessionId, "session_init", {
        model: typeof msg.model === "string" ? msg.model : undefined,
        agentChatId: typeof msg.session_id === "string" ? msg.session_id : undefined,
      }),
    );
    return events;
  }

  if (type === "assistant") {
    const content = (msg.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          events.push(claudeEvent(sessionId, "text", { role: "assistant", text: block.text }));
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          events.push(claudeEvent(sessionId, "thinking", { role: "assistant", text: block.thinking }));
        } else if (block.type === "tool_use") {
          events.push(
            claudeEvent(sessionId, "tool_use", {
              role: "assistant",
              toolName: typeof block.name === "string" ? block.name : undefined,
              toolId: typeof block.id === "string" ? block.id : undefined,
              toolInput: block.input,
            }),
          );
        }
      }
    }
    return events;
  }

  // claude delivers tool RESULTS as a `user` message with tool_result blocks.
  if (type === "user") {
    const content = (msg.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "tool_result") {
          const raw = block.content;
          const contentStr =
            typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : undefined;
          events.push(
            claudeEvent(sessionId, "tool_result", {
              toolId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
              toolResult: {
                content: contentStr,
                isError: block.is_error === true,
              },
            }),
          );
        }
      }
    }
    return events;
  }

  if (type === "result") {
    const usageRaw = (msg.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    const inputTokens = num(usageRaw.input_tokens);
    const outputTokens = num(usageRaw.output_tokens);
    const cacheReadTokens = num(usageRaw.cache_read_input_tokens);
    const cacheCreateTokens = num(usageRaw.cache_creation_input_tokens);
    // Primary answering model: the result's own `model`, else the primary/
    // requested model threaded in from runTurn. NEVER a `modelUsage` key (that
    // enumerates subagents too — see the fn doc comment).
    const model =
      (typeof msg.model === "string" && msg.model ? msg.model : undefined) ??
      fallbackModel ??
      "";
    const usage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens,
      ...(typeof msg.total_cost_usd === "number" ? { costUsd: msg.total_cost_usd } : {}),
      model,
    };
    events.push(claudeEvent(sessionId, "usage", { usage, model: model || undefined }));
    events.push(
      claudeEvent(sessionId, "result", {
        usage,
        model: model || undefined,
        ...(msg.is_error === true && typeof msg.result === "string"
          ? { text: msg.result }
          : {}),
      }),
    );
    // A failed turn (`result.is_error`) also emits a typed `error` event so the
    // UI can distinguish it from a successful turn (kept alongside `result`).
    if (msg.is_error === true) {
      const errText = typeof msg.result === "string" ? msg.result : "turn failed";
      events.push(claudeEvent(sessionId, "error", { text: errText }));
    }
    return events;
  }

  // Rate-limit throttling — surface only genuine throttle states as a transient
  // status so the UI can show the `rejected`/`throttled`/`queued` state. The CLI
  // also streams `allowed`/`allowed_warning` heartbeats (and status-less events)
  // constantly; those are benign and were spamming the UI, so we drop everything
  // not in the whitelist. A novel throttle status would be dropped too — an
  // acceptable trade for the reduced noise.
  if (type === "rate_limit_event") {
    const rl = (msg.rate_limit ?? {}) as Record<string, unknown>;
    const raw =
      typeof rl.status === "string"
        ? rl.status
        : typeof msg.status === "string"
          ? msg.status
          : "";
    const status = raw.toLowerCase();
    const THROTTLE_STATUSES = new Set(["rejected", "throttled", "queued"]);
    if (!THROTTLE_STATUSES.has(status)) return []; // benign/heartbeat/unknown → drop
    events.push(claudeEvent(sessionId, "status", { text: `rate limit: ${status}` }));
    return events;
  }

  return [];
}

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

const CLAUDE_MODELS = [
  "sonnet",
  "opus",
  "haiku",
  "fable",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-fable-5",
] as const;

export function createClaudePlugin(): AgentPlugin {
  return {
    name: "claude",
    defaultModel: "sonnet",
    promptDelivery: "inline",

    async listModels() {
      // Claude has no CLI list-models command; return a curated static list.
      return { models: [...CLAUDE_MODELS] };
    },

    getLaunchCommand(): string[] {
      return ["claude"];
    },

    getEnvironment(): Record<string, string> {
      return {
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
      };
    },

    getReadySignal() {
      return {
        sentinel: "> ",
        fallbackMs: 15_000,
      };
    },

    composeLaunchPrompt(prompt: {
      systemPrompt: string;
      taskPrompt?: string;
      sessionId: string;
      systemPromptFile: string;
      launchCfg: LaunchConfig;
    }) {
      // Shell-line launch: $(cat '<file>') reads the prompt at exec time, avoiding
      // ARG_MAX limits for long prompts. spawn.ts wraps this in `sh -lc <shellLine>`.
      const filePart = `"$(cat ${sq(prompt.systemPromptFile)})"`;
      let shellLine = `claude --dangerously-skip-permissions --chrome --system-prompt ${filePart}`;
      if (prompt.launchCfg.model) {
        shellLine += ` --model ${sq(prompt.launchCfg.model)}`;
      }
      if (prompt.taskPrompt) {
        shellLine += ` ${sq(prompt.taskPrompt)}`;
      }
      return {
        useShell: true as const,
        shellLine,
        launchArgs: undefined,
        postLaunchInput: undefined,
      };
    },

    async setupWorkspaceHooks(worktreePath: string): Promise<void> {
      const claudeDir = join(worktreePath, ".claude");
      const hookScriptPath = join(claudeDir, "vibe-recorder.sh");
      const settingsPath = join(claudeDir, "settings.json");

      await fs.mkdir(claudeDir, { recursive: true });

      const hookScript = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'token="${VST_SPAWN_TOKEN:-}"',
        '[ -z "$token" ] && exit 0',
        "uuid=$(jq -r '.session_id // empty')",
        '[ -z "$uuid" ] && exit 0',
        'dir="$CLAUDE_PROJECT_DIR/.vibe-station/agent-chat-ids"',
        'mkdir -p "$dir"',
        'printf \'%s\' "$uuid" > "$dir/$token"',
      ].join("\n") + "\n";

      await fs.writeFile(hookScriptPath, hookScript, { mode: 0o755 });

      // Add .claude/ to .gitignore (best-effort)
      await ensureGitignoreEntry(join(worktreePath, ".gitignore"), ".claude/").catch(() => {});

      // Merge our SessionStart hook entry into .claude/settings.json
      let settings: Record<string, unknown> = {};
      try {
        const existing = await fs.readFile(settingsPath, "utf8");
        settings = JSON.parse(existing) as Record<string, unknown>;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      const existingHooks = settings.hooks as Record<string, unknown[]> | undefined;
      const sessionStartHooks = (existingHooks?.SessionStart ?? []) as unknown[];
      const alreadyPresent = sessionStartHooks.some(
        (entry) =>
          Array.isArray((entry as { hooks?: unknown[] }).hooks) &&
          (entry as { hooks: { type?: string; command?: string }[] }).hooks.some(
            (h) => h.command === ".claude/vibe-recorder.sh",
          ),
      );

      if (!alreadyPresent) {
        const ourEntry = {
          hooks: [{ type: "command", command: ".claude/vibe-recorder.sh" }],
        };
        settings.hooks = {
          ...(settings.hooks as Record<string, unknown>),
          SessionStart: [...sessionStartHooks, ourEntry],
        };
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
      }
    },

    async captureChatId(args: {
      session: SessionRecord;
      project: ProjectRecord;
      cwd: string;
    }): Promise<string | null> {
      const tokenFile = join(args.cwd, ".vibe-station", "agent-chat-ids", args.session.id);
      try {
        const uuid = (await fs.readFile(tokenFile, "utf8")).trim();
        await fs.unlink(tokenFile).catch(() => {});
        return uuid || null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    supportsJson(): boolean {
      return true;
    },

    /**
     * Run ONE JSON-channel turn (Decision 2/3). Spawns claude headless with
     * `--output-format stream-json`, message on stdin, and yields NormalizedEvents
     * as lines arrive. Own process group (detached) so a stuck turn can be killed
     * as a group and never orphaned into the checkout (Decision 13).
     *
     * Headless — no `--chrome` (that flag is TTY-only). System prompt applied on
     * the first turn via `--append-system-prompt`; resumed turns rely on claude's
     * own session state (`--resume <chatId>`, never `--fork-session`).
     */
    async *runTurn(
      input: TurnInput,
      ctx: TurnContext,
      signal: AbortSignal,
    ): AsyncIterable<NormalizedEvent> {
      const sessionId = ctx.session.id;
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (ctx.model) args.push("--model", ctx.model);
      if (ctx.forkFromChatId) {
        // Edit-a-sent-message fork (R3.2/R3.5): resume the original session but
        // `--fork-session` branches it into a NEW session id, so re-running from
        // the fork point never mutates the original branch.
        args.push("--resume", ctx.forkFromChatId, ...(this.getForkCommand?.() ?? ["--fork-session"]));
      } else if (ctx.chatId) {
        args.push("--resume", ctx.chatId);
      }
      if (input.isFirstTurn) {
        const systemPrompt = await fs.readFile(ctx.systemPromptFile, "utf8").catch(() => "");
        if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
      }

      const child = spawn("claude", args, {
        cwd: ctx.cwd,
        detached: true, // own process group for group-kill on abort
        stdio: ["pipe", "pipe", "pipe"],
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

      // Deliver the user's message on stdin (avoids MAX_ARG_STRLEN on large msgs).
      child.stdin?.write(input.message);
      child.stdin?.end();

      const exitPromise = new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 0));
      });

      try {
        // Track the primary model across lines (session_init reports claude's
        // real model) so the `result`/`usage` model resolves to the answering
        // model, not a subagent. Seeded with the requested model when set.
        let primaryModel = ctx.model;
        const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        for await (const line of rl) {
          for (const ev of parseClaudeStreamLine(line, sessionId, primaryModel)) {
            if (ev.kind === "session_init" && ev.model) primaryModel = ev.model;
            yield ev;
          }
        }
        const code = await exitPromise;
        if (code !== 0 && !signal.aborted) {
          throw new Error(`claude exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
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

    /** Fork flag (R3.2/R3.5): claude branches a resumed session with `--fork-session`. */
    getForkCommand(): string[] {
      return ["--fork-session"];
    },

    async getRestoreCommand(args: {
      session: SessionRecord;
      project: ProjectRecord;
      cwd: string;
      model?: string;
    }): Promise<string[] | null> {
      const { cwd, session, model } = args;
      const uuid = session.agentChatId ?? (await findLatestChatUuid(cwd));
      if (uuid) {
        const argv = ["claude", "--resume", uuid, "--dangerously-skip-permissions", "--chrome"];
        if (model) argv.push("--model", model);
        return argv;
      }
      return null;
    },
  };
}
