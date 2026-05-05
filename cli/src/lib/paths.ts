import { homedir } from "node:os";
import { join } from "node:path";

/** ~/.vibe-station/logs/daemon.log */
export function daemonLogPath(): string {
  return join(homedir(), ".vibe-station", "logs", "daemon.log");
}
