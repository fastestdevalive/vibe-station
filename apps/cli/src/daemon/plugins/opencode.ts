/**
 * OpenCode CLI plugin.
 * Implements AgentPlugin interface for the `opencode` interactive agent.
 *
 * Delivery: post-launch — system and task prompts are sent to stdin after launch.
 * Ready signal: waits for "opencode" banner in pane output.
 */

import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";

export function createOpencodePlugin(): AgentPlugin {
  return {
    name: "opencode",
    promptDelivery: "post-launch",

    getLaunchCommand(): string[] {
      return ["opencode"];
    },

    getEnvironment(): Record<string, string> {
      return {};
    },

    getReadySignal() {
      return {
        sentinel: "opencode",
        fallbackMs: 10_000,
      };
    },

    composeLaunchPrompt(prompt: { systemPrompt: string; taskPrompt?: string }) {
      const parts = [prompt.systemPrompt];
      if (prompt.taskPrompt) {
        parts.push(prompt.taskPrompt);
      }
      return {
        launchArgs: undefined,
        postLaunchInput: parts.join("\n\n"),
      };
    },

    async setupWorkspaceHooks(): Promise<void> {
      // No-op for v1
    },
  };
}
