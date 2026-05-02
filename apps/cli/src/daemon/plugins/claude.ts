/**
 * Claude Code CLI plugin.
 * Implements AgentPlugin interface for the `claude` command-line agent.
 *
 * Delivery: inline — system and task prompts are passed via CLI flags.
 * Ready signal: waits for interactive prompt sentinel ("> ").
 */

import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";
import { worktreePath as getWorktreePath } from "../services/paths.js";
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

    composeLaunchPrompt(prompt: { systemPrompt: string; taskPrompt?: string }) {
      const launchArgs: string[] = [
        "--dangerously-skip-permissions",
        "--system-prompt",
        prompt.systemPrompt,
      ];
      if (prompt.taskPrompt) {
        launchArgs.push(prompt.taskPrompt);
      }
      return {
        launchArgs,
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
