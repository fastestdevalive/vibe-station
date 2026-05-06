/**
 * Google Gemini CLI plugin (`gemini` from @google/gemini-cli).
 *
 * System prompt:  GEMINI_SYSTEM_MD env var → path to the session system-prompt file.
 *                 Read by getCoreSystemPrompt() in the CLI at startup.
 *
 * Task prompt:    Inline via `-i <prompt>` (--prompt-interactive).
 *                 Executes the prompt and stays in interactive mode — no stdin paste needed.
 *
 * Session ID:     Pre-minted in provideChatId() via crypto.randomUUID(), passed as
 *                 --session-id at launch so getRestoreCommand() can reliably --resume it.
 *
 * Auto-approve:   --yolo skips per-tool confirmation (like --dangerously-skip-permissions).
 * Trust:          --skip-trust suppresses the workspace-trust prompt on every launch.
 */

import { randomUUID } from "node:crypto";
import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";
import { systemPromptPath } from "../services/paths.js";
import type { SessionRecord, ProjectRecord, WorktreeRecord } from "../types.js";

const GEMINI_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"] as const;

export function createGeminiPlugin(): AgentPlugin {
  return {
    name: "gemini",
    defaultModel: "gemini-2.5-pro",
    promptDelivery: "inline",

    async listModels() {
      return { models: [...GEMINI_MODELS] };
    },

    getLaunchCommand(cfg: LaunchConfig): string[] {
      const argv = ["gemini", "--yolo", "--skip-trust"];
      if (cfg.model) argv.push("-m", cfg.model);
      // --session-id is set after provideChatId() populates session.agentChatId
      if (cfg.session.agentChatId) argv.push("--session-id", cfg.session.agentChatId);
      return argv;
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
      // Deliver task prompt inline via -i so it's executed immediately on startup.
      // -i is appended to argv by spawn.ts via the launchArgs return value.
      if (prompt.taskPrompt) {
        return { launchArgs: ["-i", prompt.taskPrompt] };
      }
      return {};
    },

    async provideChatId(): Promise<string> {
      // Pre-mint a UUID so getLaunchCommand can pass --session-id at spawn time,
      // giving getRestoreCommand a stable ID to --resume later.
      return randomUUID();
    },

    async getRestoreCommand(args: {
      session: SessionRecord;
      project: ProjectRecord;
      worktree: WorktreeRecord;
      model?: string;
    }): Promise<string[] | null> {
      const { session, model } = args;
      if (!session.agentChatId) return null;
      const argv = ["gemini", "--yolo", "--skip-trust", "--resume", session.agentChatId];
      if (model) argv.push("-m", model);
      return argv;
    },
  };
}
