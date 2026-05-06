/**
 * Agent plugin registry.
 * Resolves concrete AgentPlugin implementations by CLI name.
 */

import type { AgentPlugin } from "../services/spawn.js";
import { createClaudePlugin } from "./claude.js";
import { createCursorPlugin } from "./cursor.js";
import { createGeminiPlugin } from "./gemini.js";
import { createOpencodePlugin } from "./opencode.js";

export const PLUGIN_MAP = {
  claude: createClaudePlugin,
  cursor: createCursorPlugin,
  opencode: createOpencodePlugin,
  gemini: createGeminiPlugin,
} as const satisfies Record<string, () => AgentPlugin>;

export type CliId = keyof typeof PLUGIN_MAP;

export const SUPPORTED_CLIS = Object.keys(PLUGIN_MAP) as CliId[];

/**
 * Resolve a concrete AgentPlugin for the given CLI identifier.
 * @throws Error if the CLI is not recognized.
 */
export function resolvePlugin(cli: CliId): AgentPlugin {
  if (!(cli in PLUGIN_MAP)) {
    throw new Error(`Unknown CLI: ${String(cli)}`);
  }
  return PLUGIN_MAP[cli]();
}
