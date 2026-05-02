import { homedir } from "node:os";
import { join } from "node:path";

/** ~/.viberun */
export function vrunHome(): string {
  return join(homedir(), ".viberun");
}

/** ~/.viberun/projects/<id> */
export function projectDir(projectId: string): string {
  return join(vrunHome(), "projects", projectId);
}

/** ~/.viberun/projects/<id>/manifest.json */
export function manifestPath(projectId: string): string {
  return join(projectDir(projectId), "manifest.json");
}

/** ~/.viberun/projects/<id>/manifest.json.tmp */
export function manifestTmpPath(projectId: string): string {
  return join(projectDir(projectId), "manifest.json.tmp");
}

/** ~/.viberun/projects/<id>/worktrees/<worktreeId> */
export function worktreePath(projectId: string, worktreeId: string): string {
  return join(projectDir(projectId), "worktrees", worktreeId);
}

/** ~/.viberun/config.json */
export function configPath(): string {
  return join(vrunHome(), "config.json");
}

/** ~/.viberun/modes.json */
export function modesPath(): string {
  return join(vrunHome(), "modes.json");
}

/** ~/.viberun/logs/daemon.log */
export function daemonLogPath(): string {
  return join(vrunHome(), "logs", "daemon.log");
}
