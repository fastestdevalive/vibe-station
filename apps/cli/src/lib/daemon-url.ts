import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { die } from "./output.js";

interface ConfigFile {
  port: number;
}

export function getDaemonUrl(): string | null {
  const envUrl = process.env.VR_DAEMON_URL;
  if (envUrl) {
    return envUrl;
  }

  try {
    const configPath = join(homedir(), ".viberun", "config.json");
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as ConfigFile;
    if (!config.port) {
      return null;
    }
    return `http://127.0.0.1:${config.port}`;
  } catch {
    return null;
  }
}

export function getDaemonUrlOrThrow(): string {
  const url = getDaemonUrl();
  if (!url) {
    die("Daemon is not running. Run `vrun daemon start`.", 4);
  }
  return url;
}
