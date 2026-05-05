// @ts-nocheck
/**
 * Agent plugin registry.
 * Resolves concrete AgentPlugin implementations by CLI name.
 */

import type { AgentPlugin } from "../services/spawn.js";
import type { CliId } from "../types.js";
import { createClaudePlugin } from "./claude.js";
import { createCursorPlugin } from "./cursor.js";
import { createOpencodePlugin } from "./opencode.js";

export const SUPPORTED_CLIS: CliId[] = ["claude", "cursor", "opencode"];

/**
 * Resolve a concrete AgentPlugin for the given CLI identifier.
 * @throws Error if the CLI is not recognized.
 */
export function resolvePlugin(cli: CliId): AgentPlugin {
  switch (cli) {
    case "claude":
      return createClaudePlugin();
    case "cursor":
      return createCursorPlugin();
    case "opencode":
      return createOpencodePlugin();
    default:
      const _exhaustive: never = cli;
      throw new Error(`Unknown CLI: ${String(_exhaustive)}`);
  }
}
