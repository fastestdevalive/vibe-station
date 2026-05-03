/**
 * Claude Code CLI plugin.
 * Implements AgentPlugin interface for the `claude` command-line agent.
 *
 * Delivery: inline — system and task prompts are passed via CLI flags.
 * Ready signal: waits for interactive prompt sentinel ("> ").
 */

import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";
import { worktreePath as getWorktreePath } from "../services/paths.js";
import { sq } from "../services/shell.js";
import { findLatestChatUuid } from "./claudeRestore.js";

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
      const filePart = `$(cat ${sq(prompt.systemPromptFile)})`;
      let shellLine = `claude --dangerously-skip-permissions --system-prompt ${filePart}`;
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

    async setupWorkspaceHooks(): Promise<void> {
      // No-op for v1; hooks are implemented in v1.1
    },

    async getRestoreCommand(args: {
      session: any;
      project: any;
      worktree: any;
    }): Promise<string[] | null> {
      const { project, worktree } = args;
      const wtPath = getWorktreePath(project.id, worktree.id);
      const uuid = await findLatestChatUuid(wtPath);
      if (uuid) {
        return ["claude", "--resume", uuid, "--dangerously-skip-permissions"];
      }
      return null;
    },
  };
}
