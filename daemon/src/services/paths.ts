import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { rmSync } from "node:fs";

/**
 * Guard against ever deleting anything outside the vibe-station data dir —
 * most importantly a project's own working directory. A direct session runs
 * *inside* the project checkout, so a bug that passed `project.absolutePath`
 * (or any ancestor/descendant of it) to a cleanup helper could wipe the user's
 * code. This is defense-in-depth: throws unless `target` is strictly inside
 * `~/.vibe-station/`.
 *
 * @param target The path about to be removed.
 * @param protectedPath A path that must never be touched (e.g. the project dir).
 */
export function assertSafeToDelete(target: string, protectedPath?: string): void {
  const abs = resolve(target);
  const home = resolve(vstHome());

  // Must live strictly under ~/.vibe-station/ (not the home dir itself).
  const relToHome = relative(home, abs);
  const insideHome = relToHome !== "" && !relToHome.startsWith("..") && !isAbsolute(relToHome);
  if (!insideHome) {
    throw new Error(`Refusing to delete '${abs}' — outside ${home}`);
  }

  if (protectedPath) {
    const prot = resolve(protectedPath);
    // Reject if target equals, contains, or is contained by the protected path.
    const relFromProt = relative(prot, abs);
    const targetInsideProt =
      abs === prot || (!relFromProt.startsWith("..") && !isAbsolute(relFromProt));
    const relToTarget = relative(abs, prot);
    const protInsideTarget =
      abs === prot || (!relToTarget.startsWith("..") && !isAbsolute(relToTarget));
    if (targetInsideProt || protInsideTarget) {
      throw new Error(`Refusing to delete '${abs}' — overlaps protected path '${prot}'`);
    }
  }
}

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

/** ~/.vibe-station/vibe-station.db — sole source of truth for projects/worktrees/sessions metadata. */
export function dbPath(): string {
  return join(vstHome(), "vibe-station.db");
}

/** ~/.vibe-station/logs/daemon.log */
export function daemonLogPath(): string {
  return join(vstHome(), "logs", "daemon.log");
}

/** ~/.vibe-station/projects/<p>/session-data/<w>/<s> — per-session data dir (sibling of worktrees/, not inside the checkout) */
export function sessionDataDir(projectId: string, worktreeId: string, sessionId: string): string {
  return join(projectDir(projectId), "session-data", worktreeId, sessionId);
}

/** ~/.vibe-station/projects/<p>/sessions/<s> — data dir for direct sessions (no worktree) */
export function directSessionDataDir(projectId: string, sessionId: string): string {
  return join(projectDir(projectId), "sessions", sessionId);
}

/** <sessionDataDir>/system-prompt.md */
export function systemPromptPath(projectId: string, worktreeId: string, sessionId: string): string {
  return join(sessionDataDir(projectId, worktreeId, sessionId), "system-prompt.md");
}

/** <directSessionDataDir>/system-prompt.md */
export function directSystemPromptPath(projectId: string, sessionId: string): string {
  return join(directSessionDataDir(projectId, sessionId), "system-prompt.md");
}

/** <sessionDataDir>/opencode-config.json */
export function opencodeConfigPath(projectId: string, worktreeId: string, sessionId: string): string {
  return join(sessionDataDir(projectId, worktreeId, sessionId), "opencode-config.json");
}

/** <directSessionDataDir>/opencode-config.json */
export function directOpencodeConfigPath(projectId: string, sessionId: string): string {
  return join(directSessionDataDir(projectId, sessionId), "opencode-config.json");
}

/** Best-effort rm -rf of the per-session data dir. */
export function cleanupSessionDataDir(projectId: string, worktreeId: string, sessionId: string): void {
  try {
    const dir = sessionDataDir(projectId, worktreeId, sessionId);
    assertSafeToDelete(dir); // never anything outside ~/.vibe-station/
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Best-effort rm -rf of a direct session data dir. */
export function cleanupDirectSessionDataDir(projectId: string, sessionId: string): void {
  try {
    const dir = directSessionDataDir(projectId, sessionId);
    assertSafeToDelete(dir); // never the project checkout — only the data dir
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
