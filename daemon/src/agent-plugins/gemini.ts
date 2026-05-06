/**
 * Google Gemini CLI plugin (`gemini` from @google/gemini-cli).
 *
 * System instructions: GEMINI_SYSTEM_MD env points at the session system-prompt file.
 * Task prompt: post-launch paste after ready sentinel (same pattern as opencode).
 */

import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";
import { systemPromptPath } from "../services/paths.js";

const GEMINI_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"] as const;

export function createGeminiPlugin(): AgentPlugin {
  return {
    name: "gemini",
    defaultModel: "gemini-2.5-pro",
    promptDelivery: "post-launch",
    postSentinelDelayMs: 500,

    async listModels() {
      return { models: [...GEMINI_MODELS] };
    },

    getLaunchCommand(cfg: LaunchConfig): string[] {
      if (cfg.model) {
        return ["gemini", "-m", cfg.model];
      }
      return ["gemini"];
    },

    getEnvironment(cfg: LaunchConfig): Record<string, string> {
      return {
        GEMINI_SYSTEM_MD: systemPromptPath(cfg.project.id, cfg.worktree.id, cfg.session.id),
      };
    },

    getReadySignal() {
      return { sentinel: "╭", fallbackMs: 10_000 };
    },

    composeLaunchPrompt(prompt: {
      systemPrompt: string;
      taskPrompt?: string;
      sessionId: string;
      systemPromptFile: string;
      launchCfg: LaunchConfig;
    }) {
      const parts: string[] = [];
      if (prompt.taskPrompt) {
        parts.push(prompt.taskPrompt);
      }
      parts.push(`<!-- VSTPRMT:${prompt.sessionId} -->`);
      return {
        postLaunchInput: parts.join("\n\n"),
        postLaunchSubmit: true,
      };
    },

    async getRestoreCommand(): Promise<string[] | null> {
      return null;
    },
  };
}
