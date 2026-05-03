import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

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

/** ~/.viberun/projects/<p>/worktrees/<w>/sessions/<s> — per-session data dir */
export function sessionDataDir(projectId: string, worktreeId: string, sessionId: string): string {
  return join(projectDir(projectId), "worktrees", worktreeId, "sessions", sessionId);
}

/** <sessionDataDir>/system-prompt.md */
export function systemPromptPath(projectId: string, worktreeId: string, sessionId: string): string {
  return join(sessionDataDir(projectId, worktreeId, sessionId), "system-prompt.md");
}

/** <sessionDataDir>/opencode-config.json */
export function opencodeConfigPath(projectId: string, worktreeId: string, sessionId: string): string {
  return join(sessionDataDir(projectId, worktreeId, sessionId), "opencode-config.json");
}

/** Best-effort rm -rf of the per-session data dir. */
export function cleanupSessionDataDir(projectId: string, worktreeId: string, sessionId: string): void {
  try {
    rmSync(sessionDataDir(projectId, worktreeId, sessionId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
