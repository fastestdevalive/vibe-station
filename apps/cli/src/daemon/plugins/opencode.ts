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
    postSentinelDelayMs: 500,

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

    async getRestoreCommand(args: { session: any }): Promise<string[] | null> {
      const { session } = args;
      // KNOWN LIMITATION: agentChatId is not yet captured at launch time.
      // ao-142 queries `opencode session list --format json` and matches by
      // title (e.g. AO:<id>); we don't do that yet. Until either (a) we parse
      // sessionId from the opencode startup banner, or (b) we shell out to
      // `opencode session list`, this restore path is effectively dead — it
      // always falls through to fresh launch. Tracked as Phase-2 follow-up.
      if (session.agentChatId) {
        return ["opencode", "--session", session.agentChatId];
      }
      return null;
    },
  };
}
