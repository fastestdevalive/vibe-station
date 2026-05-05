// @ts-nocheck
/**
 * Writes an opencode JSON config file that points to system-prompt instruction
 * files and configures permissions.
 *
 * opencode reads OPENCODE_CONFIG env var and uses `instructions` as system-
 * level context. The `permission` block opts the session into full permissive
 * mode — `{"*": {"*": "allow"}}` matches every tool category and every action,
 * so the agent never blocks on an interactive Y/N prompt. This mirrors the
 * "permissionless" posture we already get for claude (--dangerously-skip-
 * permissions) and cursor (--sandbox disabled --approve-mcps).
 */
import { writeFileSync } from "node:fs";

export interface OpenCodeConfig {
  instructions: string[];
  permission: Record<string, Record<string, "allow" | "ask" | "deny">>;
}

/**
 * Write { instructions: [<absolutePaths>], permission: {...} } to <configPath>.
 * Returns the config path for convenience.
 */
export function writeOpenCodeConfig(configPath: string, instructionFiles: string[]): string {
  const config: OpenCodeConfig = {
    instructions: instructionFiles,
    permission: { "*": { "*": "allow" } },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}
