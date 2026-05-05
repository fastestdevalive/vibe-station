/**
 * Claude Code CLI plugin.
 * Implements AgentPlugin interface for the `claude` command-line agent.
 *
 * Delivery: inline — system and task prompts are passed via CLI flags.
 * Ready signal: waits for interactive prompt sentinel ("> ").
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";
import { worktreePath as getWorktreePath } from "../services/paths.js";
import { sq } from "../services/shell.js";
import { findLatestChatUuid } from "./claudeRestore.js";
import type { SessionRecord, ProjectRecord, WorktreeRecord } from "../types.js";

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

export function createClaudePlugin(): AgentPlugin {
  return {
    name: "claude",
    promptDelivery: "inline",

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
      let shellLine = `claude --dangerously-skip-permissions --system-prompt ${filePart}`;
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
      worktree: WorktreeRecord;
    }): Promise<string | null> {
      const wtPath = getWorktreePath(args.project.id, args.worktree.id);
      const tokenFile = join(wtPath, ".vibe-station", "agent-chat-ids", args.session.id);
      try {
        const uuid = (await fs.readFile(tokenFile, "utf8")).trim();
        await fs.unlink(tokenFile).catch(() => {});
        return uuid || null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async getRestoreCommand(args: {
      session: SessionRecord;
      project: ProjectRecord;
      worktree: WorktreeRecord;
      model?: string;
    }): Promise<string[] | null> {
      const { project, worktree, session, model } = args;
      const uuid =
        session.agentChatId ??
        (await findLatestChatUuid(getWorktreePath(project.id, worktree.id)));
      if (uuid) {
        const argv = ["claude", "--resume", uuid, "--dangerously-skip-permissions"];
        if (model) argv.push("--model", model);
        return argv;
      }
      return null;
    },
  };
}
