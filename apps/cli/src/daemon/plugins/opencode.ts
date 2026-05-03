/**
 * OpenCode CLI plugin.
 * Implements AgentPlugin interface for the `opencode` interactive agent.
 *
 * System-prompt delivery: OPENCODE_CONFIG env — writes a JSON config with
 * `instructions: [<systemPromptFile>]`; opencode reads it as system instructions.
 * Task-prompt delivery: post-launch — pasted to stdin after ready sentinel.
 * Ready signal: waits for "opencode" banner in pane output.
 */

import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";
import { opencodeConfigPath, systemPromptPath } from "../services/paths.js";
import { writeOpenCodeConfig } from "../services/opencodeConfig.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createOpencodePlugin(): AgentPlugin {
  return {
    name: "opencode",
    promptDelivery: "post-launch",
    postSentinelDelayMs: 500,

    getLaunchCommand(): string[] {
      return ["opencode"];
    },

    getEnvironment(cfg: LaunchConfig): Record<string, string> {
      // Write (or re-write) the opencode config pointing at the system-prompt file.
      // This runs both on fresh spawn and on restore — so updated AGENTS.md is always picked up.
      const configPath = opencodeConfigPath(cfg.project.id, cfg.worktree.id, cfg.session.id);
      const promptFile = systemPromptPath(cfg.project.id, cfg.worktree.id, cfg.session.id);
      try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeOpenCodeConfig(configPath, [promptFile]);
      } catch {
        // best-effort — if data dir doesn't exist yet (before spawnSession writes it),
        // spawnSession will write the prompt file and spawn will re-set the env anyway.
      }
      return { OPENCODE_CONFIG: configPath };
    },

    getReadySignal() {
      return {
        sentinel: "opencode",
        fallbackMs: 10_000,
      };
    },

    composeLaunchPrompt(prompt: {
      systemPrompt: string;
      taskPrompt?: string;
      sessionId: string;
      systemPromptFile: string;
      launchCfg: LaunchConfig;
    }) {
      // System prompt is delivered via OPENCODE_CONFIG env (see getEnvironment).
      // Only the task prompt + verification needle are sent via post-launch paste.
      const parts: string[] = [];
      if (prompt.taskPrompt) {
        parts.push(prompt.taskPrompt);
      }
      parts.push(`<!-- VSTPRMT:${prompt.sessionId} -->`);
      return {
        launchArgs: undefined,
        postLaunchInput: parts.length > 0 ? parts.join("\n\n") : undefined,
      };
    },

    async setupWorkspaceHooks(): Promise<void> {
      // No-op for v1
    },

    async getRestoreCommand(args: {
      session: { agentChatId?: string };
      project: { id: string };
      worktree: { id: string };
    }): Promise<string[] | null> {
      // KNOWN LIMITATION: agentChatId is not yet captured at launch time.
      // ao-142 queries `opencode session list --format json` and matches by
      // title (e.g. AO:<id>); we don't do that yet. Until either (a) we parse
      // sessionId from the opencode startup banner, or (b) we shell out to
      // `opencode session list`, this restore path is effectively dead — it
      // always falls through to fresh launch. Tracked as Phase-2 follow-up.
      if (args.session.agentChatId) {
        return ["opencode", "--session", args.session.agentChatId];
      }
      return null;
    },
  };
}
