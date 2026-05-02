/**
 * Claude Code CLI plugin.
 * Implements AgentPlugin interface for the `claude` command-line agent.
 *
 * Delivery: inline — system and task prompts are passed via CLI flags.
 * Ready signal: waits for interactive prompt sentinel ("> ").
 */

import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";

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
  };
}
