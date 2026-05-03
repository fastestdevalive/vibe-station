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
 * - `--sandbox disabled`: allows vrun-controlled execution; required for daemon spawn
 * - `--approve-mcps`: auto-accept MCP permission requests (no interactive gates)
 * Removed `--print` (causes immediate exit on EOF; we want interactive REPL)
 */

import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";
import { worktreePath as getWorktreePath } from "../services/paths.js";
import { findLatestCursorChatId } from "./cursorRestore.js";

export function createCursorPlugin(): AgentPlugin {
  return {
    name: "cursor",
    promptDelivery: "post-launch",

    getLaunchCommand(cfg: LaunchConfig): string[] {
      const wtPath = getWorktreePath(cfg.project.id, cfg.worktree.id);
      return [
        "cursor-agent",
        "--workspace",
        wtPath,
        "--force",
        "--sandbox",
        "disabled",
        "--approve-mcps",
      ];
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

    composeLaunchPrompt(prompt: { systemPrompt: string; taskPrompt?: string; sessionId: string }) {
      const parts = [prompt.systemPrompt];
      if (prompt.taskPrompt) {
        parts.push(prompt.taskPrompt);
      }
      parts.push(`<!-- VRPRMT:${prompt.sessionId} -->`);
      return {
        launchArgs: undefined,
        postLaunchInput: parts.join("\n\n"),
      };
    },

    async setupWorkspaceHooks(): Promise<void> {
      // No-op for v1
    },

    async getRestoreCommand(args: {
      session: unknown;
      project: { id: string };
      worktree: { id: string };
    }): Promise<string[] | null> {
      const { project, worktree } = args;
      const wtPath = getWorktreePath(project.id, worktree.id);
      const chatId = await findLatestCursorChatId(wtPath);
      if (!chatId) return null;
      // Mirror the fresh-launch flags so the restored session has the same
      // workspace/sandbox/MCP behaviour. --resume picks an existing chat.
      return [
        "cursor-agent",
        "--resume",
        chatId,
        "--workspace",
        wtPath,
        "--force",
        "--sandbox",
        "disabled",
        "--approve-mcps",
      ];
    },
  };
}
