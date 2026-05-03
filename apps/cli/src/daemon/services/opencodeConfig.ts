/**
 * Writes an opencode JSON config file that points to system-prompt instruction files.
 * opencode reads OPENCODE_CONFIG env var and uses `instructions` as system-level context.
 *
 * Mirrors ao-142 packages/core/src/opencode-config.ts.
 */
import { writeFileSync } from "node:fs";

export interface OpenCodeConfig {
  instructions: string[];
}

/**
 * Write { "instructions": [<absolutePaths>] } to <configPath>.
 * Returns the config path for convenience.
 */
export function writeOpenCodeConfig(configPath: string, instructionFiles: string[]): string {
  const config: OpenCodeConfig = { instructions: instructionFiles };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}
