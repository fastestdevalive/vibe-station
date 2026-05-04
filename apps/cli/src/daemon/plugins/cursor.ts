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
 * - `--sandbox disabled`: allows vst-controlled execution; required for daemon spawn
 * - `--approve-mcps`: auto-accept MCP permission requests (no interactive gates)
 * Removed `--print` (causes immediate exit on EOF; we want interactive REPL)
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";
import { worktreePath as getWorktreePath } from "../services/paths.js";
import { sq } from "../services/shell.js";
import { findLatestCursorChatId } from "./cursorRestore.js";

const execFile = promisify(execFileCb);

export function createCursorPlugin(): AgentPlugin {
  return {
    name: "cursor",
    // Shell-line launch: system prompt is baked into the launch command via $(cat <file>).
    // No post-launch paste for system prompt; task prompt is also inlined at launch.
    promptDelivery: "inline",

    getLaunchCommand(cfg: LaunchConfig): string[] {
      const wtPath = getWorktreePath(cfg.project.id, cfg.worktree.id);
      const argv: string[] = ["cursor-agent"];
      if (cfg.session?.agentChatId) {
        argv.push("--resume", cfg.session.agentChatId);
      }
      argv.push("--workspace", wtPath, "--force", "--sandbox", "disabled", "--approve-mcps");
      return argv;
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

      const parts: string[] = ["cursor-agent"];
      if (prompt.launchCfg.session?.agentChatId) {
        parts.push(`--resume ${prompt.launchCfg.session.agentChatId}`);
      }
      parts.push(
        `--workspace ${sq(wtPath)}`,
        "--force",
        "--sandbox disabled",
        "--approve-mcps",
        `-- "$(${stdinContent})"`,
      );
      const shellLine = parts.join(" ");
      return {
        useShell: true as const,
        shellLine,
        launchArgs: undefined,
        postLaunchInput: undefined,
      };
    },

    async setupWorkspaceHooks(): Promise<void> {
      // No-op for cursor: chat id is obtained via provideChatId (cursor-agent create-chat)
    },

    async provideChatId(): Promise<string | null> {
      try {
        const { stdout } = await execFile("cursor-agent", ["create-chat"], { timeout: 10_000 });
        return stdout.trim() || null;
      } catch {
        return null; // offline / not logged in → fresh launch, no regression
      }
    },

    async getRestoreCommand(args: {
      session: { agentChatId?: string };
      project: { id: string };
      worktree: { id: string };
    }): Promise<string[] | null> {
      // cursor-agent --resume <chatId> reloads the prior conversation from cursor's
      // local chat-history DB, which already includes the original system prompt as
      // part of the saved transcript. So we hand back the resume argv as-is — no
      // shell-line, no system-prompt re-injection. Tradeoff: a resumed session will
      // NOT pick up edits to AGENTS.md / .vibe-station/rules.md made between runs;
      // those only land on a fresh spawn.
      const { project, worktree, session } = args;
      const wtPath = getWorktreePath(project.id, worktree.id);
      const chatId = session.agentChatId ?? (await findLatestCursorChatId(wtPath));
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
