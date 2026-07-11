/**
 * Config service — read/write/merge ~/.vibe-station/config.json
 *
 * The config file stores:
 * - pid/port/token: written by main.ts on daemon start (transient)
 * - defaultProjectsDir: user setting persisted across restarts
 *
 * This service preserves main.ts fields when updating user settings.
 */
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPath, vstHome } from "./paths.js";

/** Fields written by main.ts on daemon start. */
interface MainConfig {
  pid?: number;
  port?: number;
  token?: string;
  startedAt?: string;
}

/** User-configurable settings. */
export interface UserSettings {
  defaultProjectsDir?: string;
}

/** Full config shape on disk. */
export interface Config extends MainConfig, UserSettings {}

const DEFAULT_PROJECTS_DIR_NAME = "projects";

/** Default defaultProjectsDir value: ~/projects */
export function defaultProjectsDir(): string {
  return join(homedir(), DEFAULT_PROJECTS_DIR_NAME);
}

/**
 * Read the current config.json, returning defaults for missing user fields.
 * Does not throw if the file is missing or malformed — returns defaults.
 */
export async function readConfig(): Promise<Config> {
  try {
    const content = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(content) as Config;
    return {
      ...parsed,
      defaultProjectsDir: parsed.defaultProjectsDir ?? defaultProjectsDir(),
    };
  } catch {
    // File missing or invalid JSON — return defaults
    return {
      defaultProjectsDir: defaultProjectsDir(),
    };
  }
}

/**
 * Read only the user settings portion of the config.
 */
export async function readSettings(): Promise<UserSettings> {
  const config = await readConfig();
  return {
    defaultProjectsDir: config.defaultProjectsDir ?? defaultProjectsDir(),
  };
}

/**
 * Merge partial settings into config.json, preserving main.ts fields.
 * Creates the config file if it doesn't exist.
 */
export async function writeSettings(partial: Partial<UserSettings>): Promise<void> {
  // Read existing config to preserve main.ts fields
  const existing = await readConfig();

  // Merge in new settings (only update fields that are provided)
  const updated: Config = { ...existing };
  if (partial.defaultProjectsDir !== undefined) {
    updated.defaultProjectsDir = partial.defaultProjectsDir;
  }

  // Ensure directory exists
  await mkdir(vstHome(), { recursive: true });

  // Write back with same permissions as main.ts (mode 0o600)
  await writeFile(configPath(), JSON.stringify(updated, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  // Ensure correct permissions even if file existed with wrong mode
  await chmod(configPath(), 0o600);
}
