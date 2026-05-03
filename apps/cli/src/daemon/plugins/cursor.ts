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
import { sq } from "../services/shell.js";
import { findLatestCursorChatId } from "./cursorRestore.js";

export function createCursorPlugin(): AgentPlugin {
  return {
    name: "cursor",
    // Shell-line launch: system prompt is baked into the launch command via $(cat <file>).
    // No post-launch paste for system prompt; task prompt is also inlined at launch.
    promptDelivery: "inline",

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

    composeLaunchPrompt(prompt: {
      systemPrompt: string;
      taskPrompt?: string;
      sessionId: string;
      systemPromptFile: string;
      launchCfg: LaunchConfig;
    }) {
      const wtPath = getWorktreePath(prompt.launchCfg.project.id, prompt.launchCfg.worktree.id);
      // Mirror ao-142 agent-cursor/src/index.ts:190-198:
      // cursor-agent … -- "$(cat '<file>'; printf '\n\n'; printf %s '<task>')"
      const filePart = `cat ${sq(prompt.systemPromptFile)}`;
      let stdinContent = filePart;
      if (prompt.taskPrompt) {
        stdinContent += `; printf '\\n\\n'; printf %s ${sq(prompt.taskPrompt)}`;
      }
      const shellLine = [
        "cursor-agent",
        `--workspace ${sq(wtPath)}`,
        "--force",
        "--sandbox disabled",
        "--approve-mcps",
        `-- "$(${stdinContent})"`,
      ].join(" ");
      return {
        useShell: true as const,
        shellLine,
        launchArgs: undefined,
        postLaunchInput: undefined,
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
      // Decision (phase 3.4 / open question 8): ao-142 returns null from getRestoreCommand
      // for cursor, forcing every restart through a fresh getLaunchCommand (which always
      // bakes in the system prompt via shell substitution). We adopt the same strategy:
      // cursor-agent's --resume flag + positional `--` system-prompt arg combination is
      // not verified safe, and a fresh launch always re-delivers the system prompt.
      // Resumed cursor sessions see updated AGENTS.md on every spawn.
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
