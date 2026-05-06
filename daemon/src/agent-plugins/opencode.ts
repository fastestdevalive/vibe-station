/**
 * OpenCode CLI plugin.
 * Implements AgentPlugin interface for the `opencode` interactive agent.
 *
 * System-prompt delivery: OPENCODE_CONFIG env — writes a JSON config with
 * `instructions: [<systemPromptFile>]`; opencode reads it as system instructions.
 * Task-prompt delivery: post-launch — pasted to stdin after ready sentinel.
 * Ready signal: waits for "opencode" banner in pane output.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

const execFileAsync = promisify(execFile);
import { join } from "node:path";
import type { AgentPlugin, LaunchConfig } from "../services/spawn.js";
import { opencodeConfigPath, systemPromptPath, worktreePath as getWorktreePath } from "../services/paths.js";
import { writeOpenCodeConfig } from "../services/opencodeConfig.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRecord, ProjectRecord, WorktreeRecord } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOpencodePlugin(): AgentPlugin {
  return {
    name: "opencode",
    defaultModel: "opencode/big-pickle",
    promptDelivery: "post-launch",

    async listModels() {
      try {
        const { stdout } = await execFileAsync("opencode", ["models"], {
          timeout: 15_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const models = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        return { models };
      } catch (err) {
        console.error("[cli-models] opencode fetch failed:", err);
        return { models: [], error: "Failed to fetch models from CLI. Check that the CLI is installed and authenticated." };
      }
    },
    postSentinelDelayMs: 500,

    getLaunchCommand(cfg: LaunchConfig): string[] {
      if (cfg.model) {
        return ["opencode", "-m", cfg.model];
      }
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
      // postLaunchSubmit=true → spawn.ts sends Enter after the bracketed paste so
      // the TUI actually submits the message (bracketed paste alone preserves
      // newlines but never auto-submits).
      const parts: string[] = [];
      if (prompt.taskPrompt) {
        parts.push(prompt.taskPrompt);
      }
      parts.push(`<!-- VSTPRMT:${prompt.sessionId} -->`);
      return {
        launchArgs: undefined,
        postLaunchInput: parts.length > 0 ? parts.join("\n\n") : undefined,
        postLaunchSubmit: true,
      };
    },

    async setupWorkspaceHooks(worktreePath: string): Promise<void> {
      const pluginDir = join(worktreePath, ".opencode", "plugins");
      const pluginPath = join(pluginDir, "vst-recorder.ts");

      const content =
        [
          'import type { Plugin } from "@opencode-ai/plugin";',
          'import { writeFileSync, mkdirSync } from "node:fs";',
          'import { join } from "node:path";',
          "",
          "export const VstRecorder: Plugin = async ({ directory }) => ({",
          '  "session.created": async (input) => {',
          "    const token = process.env.VST_SPAWN_TOKEN;",
          "    if (!token) return;",
          '    const dir = join(directory, ".vibe-station", "agent-chat-ids");',
          "    mkdirSync(dir, { recursive: true });",
          "    writeFileSync(join(dir, token), input.sessionID);",
          "  },",
          "});",
        ].join("\n") + "\n";

      await fs.mkdir(pluginDir, { recursive: true });

      // Idempotent: skip write if content is unchanged
      try {
        const existing = await fs.readFile(pluginPath, "utf8");
        if (existing === content) return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      await fs.writeFile(pluginPath, content, "utf8");
    },

    async captureChatId(args: {
      session: SessionRecord;
      project: ProjectRecord;
      worktree: WorktreeRecord;
    }): Promise<string | null> {
      // session.created fires when the user's first chat is created, which for the TUI
      // may be after the ready sentinel. Poll for up to 30s; timeout → null → mtime fallback.
      const tokenFile = join(
        getWorktreePath(args.project.id, args.worktree.id),
        ".vibe-station",
        "agent-chat-ids",
        args.session.id,
      );
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          const id = (await fs.readFile(tokenFile, "utf8")).trim();
          await fs.unlink(tokenFile).catch(() => {});
          return id || null;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        await sleep(500);
      }
      return null;
    },

    async getRestoreCommand(args: {
      session: { agentChatId?: string };
      project: { id: string };
      worktree: { id: string };
      model?: string;
    }): Promise<string[] | null> {
      if (args.session.agentChatId) {
        const argv = ["opencode"];
        if (args.model) argv.push("-m", args.model);
        argv.push("--session", args.session.agentChatId);
        return argv;
      }
      return null;
    },
  };
}
