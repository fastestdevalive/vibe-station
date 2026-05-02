/**
 * Cursor agent plugin.
 * Implements AgentPlugin interface for the `cursor agent` headless CLI.
 *
 * Delivery: post-launch — system and task prompts are sent to stdin after launch.
 * Ready signal: no sentinel; just wait 5 seconds for agent startup.
 */

import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";
import { worktreePath as getWorktreePath } from "../services/paths.js";

export function createCursorPlugin(): AgentPlugin {
  return {
    name: "cursor",
    promptDelivery: "post-launch",

    getLaunchCommand(cfg: LaunchConfig): string[] {
      const wtPath = getWorktreePath(cfg.project.id, cfg.worktree.id);
      return ["cursor-agent", "--print", "--workspace", wtPath];
    },

    getEnvironment(): Record<string, string> {
      return {};
    },

    getReadySignal() {
      return {
        sentinel: undefined,
        fallbackMs: 5_000,
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
