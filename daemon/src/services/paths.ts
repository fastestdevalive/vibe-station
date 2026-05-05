// @ts-nocheck
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

/** ~/.vibe-station */
export function vstHome(): string {
  return join(homedir(), ".vibe-station");
}

/** ~/.vibe-station/projects/<id> */
export function projectDir(projectId: string): string {
  return join(vstHome(), "projects", projectId);
}

/** ~/.vibe-station/projects/<id>/manifest.json */
export function manifestPath(projectId: string): string {
  return join(projectDir(projectId), "manifest.json");
}

/** ~/.vibe-station/projects/<id>/manifest.json.tmp */
export function manifestTmpPath(projectId: string): string {
  return join(projectDir(projectId), "manifest.json.tmp");
}

/** ~/.vibe-station/projects/<id>/worktrees/<worktreeId> */
export function worktreePath(projectId: string, worktreeId: string): string {
  return join(projectDir(projectId), "worktrees", worktreeId);
}

/** ~/.vibe-station/config.json */
export function configPath(): string {
  return join(vstHome(), "config.json");
}

/** ~/.vibe-station/modes.json */
export function modesPath(): string {
  return join(vstHome(), "modes.json");
}

/** ~/.vibe-station/logs/daemon.log */
export function daemonLogPath(): string {
  return join(vstHome(), "logs", "daemon.log");
}

/** ~/.vibe-station/projects/<p>/session-data/<w>/<s> — per-session data dir (sibling of worktrees/, not inside the checkout) */
export function sessionDataDir(projectId: string, worktreeId: string, sessionId: string): string {
  return join(projectDir(projectId), "session-data", worktreeId, sessionId);
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
