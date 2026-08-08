/**
 * Cursor agent plugin.
 * Implements AgentPlugin interface for the `cursor agent` headless CLI.
 *
 * Delivery: post-launch — system and task prompts are sent to stdin after launch.
 * Ready signal: no sentinel; just wait 8 seconds for agent startup.
 *
 * Launch flags rationale (aligned with ao-142):
 * - `--workspace <path>`: required; specifies project root
 * - `--force`: skip workspace-trust prompt
 * - `--sandbox disabled`: allows vst-controlled execution; required for daemon spawn
 * - `--approve-mcps`: auto-accept MCP permission requests (no interactive gates)
 * Removed `--print` (causes immediate exit on EOF; we want interactive REPL)
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { AgentPlugin, LaunchConfig, TurnInput, TurnContext } from "../services/spawn.js";
import { sq } from "../services/shell.js";
import { findLatestCursorChatId } from "./cursorRestore.js";
import type { NormalizedEvent, NormalizedEventKind } from "../types.js";

const execFile = promisify(execFileCb);

function cursorEvent(
  sessionId: string,
  kind: NormalizedEventKind,
  extra: Partial<NormalizedEvent>,
): NormalizedEvent {
  return {
    id: randomUUID(),
    sessionId,
    ts: new Date().toISOString(),
    provider: "cursor",
    kind,
    ...extra,
  };
}

/**
 * Map ONE cursor-agent `stream-json` line into zero or more NormalizedEvents
 * (Decision 3). Exported for unit testing (3.T1). Malformed lines are skipped
 * (Decision 7).
 *
 * Cursor shapes (live-verified 2026-07-14): `system/init` (session_id, model),
 * `user` (echo — suppressed), `assistant` content blocks, streamed
 * `thinking/delta` + `thinking/completed`, `tool_call/started` +
 * `tool_call/completed` (matched by `call_id`, typed `tool_call.<name>` payload),
 * and `result/success | result/error`.
 */
export function parseCursorStreamLine(line: string, sessionId: string): NormalizedEvent[] {
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

  const type = msg.type as string | undefined;
  const subtype = msg.subtype as string | undefined;
  const events: NormalizedEvent[] = [];

  if (type === "system" && subtype === "init") {
    events.push(
      cursorEvent(sessionId, "session_init", {
        ...(typeof msg.model === "string" ? { model: msg.model } : {}),
        ...(typeof msg.session_id === "string" ? { agentChatId: msg.session_id } : {}),
      }),
    );
    return events;
  }

  // Suppress the CLI's user echo — the daemon renders its own user bubble.
  if (type === "user") return [];

  if (type === "assistant") {
    const content = (msg.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          events.push(cursorEvent(sessionId, "text", { role: "assistant", text: block.text }));
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          events.push(cursorEvent(sessionId, "thinking", { role: "assistant", text: block.thinking }));
        } else if (block.type === "tool_use") {
          events.push(
            cursorEvent(sessionId, "tool_use", {
              role: "assistant",
              ...(typeof block.name === "string" ? { toolName: block.name } : {}),
              ...(typeof block.id === "string" ? { toolId: block.id } : {}),
              toolInput: block.input,
            }),
          );
        }
      }
    }
    return events;
  }

  if (type === "thinking") {
    // Streamed reasoning: `thinking/delta` carries a chunk; `thinking/completed`
    // may have no text (skip when empty).
    const text =
      (typeof msg.text === "string" ? msg.text : undefined) ??
      (typeof msg.delta === "string" ? msg.delta : undefined) ??
      (typeof msg.thinking === "string" ? msg.thinking : undefined);
    if (text) events.push(cursorEvent(sessionId, "thinking", { role: "assistant", text }));
    return events;
  }

  if (type === "tool_call") {
    const callId = typeof msg.call_id === "string" ? msg.call_id : undefined;
    const toolCall = (msg.tool_call ?? {}) as Record<string, unknown>;
    // The tool payload lives under the key ending in `ToolCall`
    // (`shellToolCall`/`readToolCall`/`editToolCall`); siblings like
    // `toolCallId`/`startedAtMs`/`hookAdditionalContexts` are NOT the tool.
    // Fall back to the first key so a shape change never drops the tool.
    const keys = Object.keys(toolCall);
    const toolName = keys.find((k) => k.endsWith("ToolCall")) ?? keys[0];
    const payload = (toolName ? toolCall[toolName] : undefined) as Record<string, unknown> | undefined;
    if (subtype === "started") {
      events.push(
        cursorEvent(sessionId, "tool_use", {
          role: "assistant",
          ...(toolName ? { toolName } : {}),
          ...(callId ? { toolId: callId } : {}),
          toolInput: payload?.args,
        }),
      );
    } else if (subtype === "completed") {
      // Cursor reports outcome under `result.success` (ok) or `result.failure`
      // (error). Surface the failure/success detail and flag isError on failure.
      const rawResult = payload?.result ?? msg.result;
      let isError = false;
      let detail: unknown = rawResult;
      if (rawResult && typeof rawResult === "object") {
        const r = rawResult as Record<string, unknown>;
        if ("failure" in r) {
          isError = true;
          detail = r.failure;
        } else if ("success" in r) {
          detail = r.success;
        }
      }
      const contentStr =
        typeof detail === "string" ? detail : detail != null ? JSON.stringify(detail) : undefined;
      events.push(
        cursorEvent(sessionId, "tool_result", {
          ...(callId ? { toolId: callId } : {}),
          toolResult: { ...(contentStr !== undefined ? { content: contentStr } : {}), isError },
        }),
      );
    }
    return events;
  }

  if (type === "result") {
    const usageRaw = (msg.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    // Cursor emits camelCase usage keys (`inputTokens`/`outputTokens`/
    // `cacheReadTokens`/`cacheWriteTokens`); snake_case kept as a defensive
    // fallback. Our `cacheCreateTokens` maps from cursor's `cacheWriteTokens`.
    const inputTokens = num(usageRaw.inputTokens ?? usageRaw.input_tokens);
    const outputTokens = num(usageRaw.outputTokens ?? usageRaw.output_tokens);
    const cacheReadTokens = num(usageRaw.cacheReadTokens ?? usageRaw.cache_read_input_tokens);
    const cacheCreateTokens = num(usageRaw.cacheWriteTokens ?? usageRaw.cache_creation_input_tokens);
    const model = typeof msg.model === "string" ? msg.model : "";
    const usage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens,
      ...(typeof msg.total_cost_usd === "number" ? { costUsd: msg.total_cost_usd } : {}),
      model,
    };
    events.push(cursorEvent(sessionId, "usage", { usage, ...(model ? { model } : {}) }));
    events.push(
      cursorEvent(sessionId, "result", {
        usage,
        ...(model ? { model } : {}),
        ...(subtype === "error" && typeof msg.result === "string" ? { text: msg.result } : {}),
      }),
    );
    // A failed turn (`result/error`) also emits a typed `error` event so the UI
    // can distinguish it from a successful turn (kept alongside `result`).
    if (subtype === "error") {
      const errText =
        typeof msg.result === "string"
          ? msg.result
          : typeof msg.error === "string"
            ? msg.error
            : "turn failed";
      events.push(cursorEvent(sessionId, "error", { text: errText }));
    }
    return events;
  }

  return [];
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

export function createCursorPlugin(): AgentPlugin {
  return {
    name: "cursor",
    defaultModel: "auto",
    // Shell-line launch: system prompt is baked into the launch command via $(cat <file>).
    // No post-launch paste for system prompt; task prompt is also inlined at launch.
    promptDelivery: "inline",

    async listModels() {
      try {
        const { stdout } = await execFile("cursor-agent", ["--list-models"], {
          timeout: 15_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const models = stdout
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0] ?? "")
          .filter(Boolean);
        return { models };
      } catch (err) {
        console.error("[cli-models] cursor-agent fetch failed:", err);
        return { models: [], error: "Failed to fetch models from CLI. Check that the CLI is installed and authenticated." };
      }
    },

    getLaunchCommand(cfg: LaunchConfig): string[] {
      const wtPath = cfg.ctx.cwd;
      const argv: string[] = ["cursor-agent"];
      if (cfg.session?.agentChatId) {
        argv.push("--resume", cfg.session.agentChatId);
      }
      if (cfg.model) {
        argv.push("--model", cfg.model);
      }
      argv.push("--workspace", wtPath, "--force", "--sandbox", "disabled", "--approve-mcps");
      return argv;
    },

    getEnvironment(): Record<string, string> {
      return {};
    },

    getReadySignal() {
      return {
        sentinel: undefined,
        fallbackMs: 8_000,
      };
    },

    composeLaunchPrompt(prompt: {
      systemPrompt: string;
      taskPrompt?: string;
      sessionId: string;
      systemPromptFile: string;
      launchCfg: LaunchConfig;
    }) {
      const wtPath = prompt.launchCfg.ctx.cwd;
      // Mirror ao-142 agent-cursor/src/index.ts:190-198:
      // cursor-agent … -- "$(cat '<file>'; printf '\n\n'; printf %s '<task>')"
      const filePart = `cat ${sq(prompt.systemPromptFile)}`;
      let stdinContent = filePart;
      if (prompt.taskPrompt) {
        stdinContent += `; printf '\\n\\n'; printf %s ${sq(prompt.taskPrompt)}`;
      }

      const parts: string[] = ["cursor-agent"];
      if (prompt.launchCfg.session?.agentChatId) {
        parts.push(`--resume ${prompt.launchCfg.session.agentChatId}`);
      }
      if (prompt.launchCfg.model) {
        parts.push(`--model ${sq(prompt.launchCfg.model)}`);
      }
      parts.push(
        `--workspace ${sq(wtPath)}`,
        "--force",
        "--sandbox disabled",
        "--approve-mcps",
        `-- "$(${stdinContent})"`,
      );
      const shellLine = parts.join(" ");
      return {
        useShell: true as const,
        shellLine,
        launchArgs: undefined,
        postLaunchInput: undefined,
      };
    },

    supportsJson(): boolean {
      return true;
    },

    /**
     * Run ONE JSON-channel turn (Decision 2/3). cursor is one-shot per turn:
     * `cursor-agent -p <msg> --output-format stream-json -f [--resume <id>]`.
     *
     * Free plans reject named models → run Auto (omit `--model`). cursor has no
     * system-prompt flag, so the system prompt is baked into message 1 only
     * (cursor.ts pattern); resumed turns rely on cursor's saved transcript and
     * must NOT re-inject it.
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

      const args = ["-p", message, "--output-format", "stream-json", "-f"];
      if (ctx.chatId) args.push("--resume", ctx.chatId);
      // Auto model on Free plans — deliberately omit `--model`.

      const child = spawn("cursor-agent", args, {
        cwd: ctx.cwd,
        detached: true,
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
          for (const ev of parseCursorStreamLine(line, sessionId)) {
            yield ev;
          }
        }
        const code = await exitPromise;
        if (code !== 0 && !signal.aborted) {
          throw new Error(`cursor-agent exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
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
      // cursor-agent has a real custom-slash-command mechanism (verified via
      // fable-model research, sqlite-agent-naming Part 02 Phase 3, Decision 3):
      // a markdown file at `.cursor/commands/<name>.md` becomes `/<name>`.
      // UNLIKE Claude Code, Cursor does NOT substitute a `$ARGUMENTS` placeholder
      // — whatever the user types after `/vst` is simply appended to the
      // conversation after this file's content, not interpolated into it. The
      // template below is phrased to read naturally with arbitrary trailing text.
      const commandsDir = join(worktreePath, ".cursor", "commands");
      const vstCommandPath = join(commandsDir, "vst.md");
      await fs.mkdir(commandsDir, { recursive: true });

      const vstCommand =
        [
          "The user just ran `/vst`, optionally followed by more text appended",
          "right after this instruction (that trailing text, if any, follows below).",
          "Read whatever follows and map it to exactly one `vst` CLI command below,",
          "then run it as a shell command. Do not improvise flags beyond these:",
          "",
          "- Nothing after `/vst`, or just `reset` -> `vst session reset $VST_SESSION`",
          "- `reset --handoff` -> see \"Important — `reset --handoff` writes its own file\" below",
          '- `reset` followed by other text -> `vst session reset $VST_SESSION --prompt "<that text>"`',
          '- `reset --handoff` followed by other text -> see below, then `vst session reset $VST_SESSION --prompt "<that text>"`',
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
          "state, remaining work, and anything the next session should know directly to",
          "`.vibe-station/HANDOFF.md` in the working directory, using a normal file-write",
          "tool call (not a shell command). Then run `vst session reset $VST_SESSION`",
          "(with `--prompt \"<that text>\"` if other text followed `--handoff`, but never",
          "`--handoff` itself) — the daemon will pick up the file you just wrote.",
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

      let existing: string | null = null;
      try {
        existing = await fs.readFile(vstCommandPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (existing !== vstCommand) {
        await fs.writeFile(vstCommandPath, vstCommand, "utf8");
      }

      // Bug 7 fix: `.cursor/` was never added to .gitignore, unlike `.claude/`
      // in claude.ts — an agent running `git add -A` would commit it. Matters
      // even more for DIRECT sessions (no worktree isolation): `worktreePath`
      // here is the project's real `absolutePath`, not a throwaway checkout.
      await ensureGitignoreEntry(join(worktreePath, ".gitignore"), ".cursor/").catch(() => {});
    },

    async provideChatId(): Promise<string | null> {
      try {
        const { stdout } = await execFile("cursor-agent", ["create-chat"], { timeout: 10_000 });
        return stdout.trim() || null;
      } catch {
        return null; // offline / not logged in → fresh launch, no regression
      }
    },

    async getRestoreCommand(args: {
      session: { agentChatId?: string };
      project: { id: string };
      cwd: string;
      model?: string;
    }): Promise<string[] | null> {
      // cursor-agent --resume <chatId> reloads the prior conversation from cursor's
      // local chat-history DB, which already includes the original system prompt as
      // part of the saved transcript. So we hand back the resume argv as-is — no
      // shell-line, no system-prompt re-injection. Tradeoff: a resumed session will
      // NOT pick up edits to AGENTS.md / .vibe-station/rules.md made between runs;
      // those only land on a fresh spawn.
      const { cwd, session, model } = args;
      const chatId = session.agentChatId ?? (await findLatestCursorChatId(cwd));
      if (!chatId) return null;
      // Mirror the fresh-launch flags so the restored session has the same
      // workspace/sandbox/MCP behaviour. --resume picks an existing chat.
      const argv = ["cursor-agent", "--resume", chatId];
      if (model) argv.push("--model", model);
      argv.push("--workspace", cwd, "--force", "--sandbox", "disabled", "--approve-mcps");
      return argv;
    },
  };
}
