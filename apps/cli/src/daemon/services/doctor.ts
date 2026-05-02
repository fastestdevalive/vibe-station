/**
 * System health checks for `vrun doctor`.
 * Checks:
 * - tmux on PATH
 * - git >= 2.20
 * - claude/cursor/opencode on PATH (warns if missing, doesn't fail)
 * - orphan tmux sessions (named vr-* whose project is no longer in manifest)
 * - orphan worktree dirs
 */
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { getAllProjects } from "../state/project-store.js";
import { listSessions } from "./tmux.js";
import { worktreePath as getWorktreePath } from "./paths.js";

const exec = promisify(execCb);

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
}

async function checkBinary(binary: string): Promise<boolean> {
  try {
    await exec(`which ${binary}`);
    return true;
  } catch {
    return false;
  }
}

async function checkGitVersion(): Promise<DoctorCheck> {
  try {
    const { stdout } = await exec("git --version");
    // Expected format: "git version 2.XX.X"
    const match = stdout.match(/git version (\d+)\.(\d+)/);
    if (!match) return { name: "git", status: "warn", message: "Could not parse git version" };
    const major = parseInt(match[1] ?? "0", 10);
    const minor = parseInt(match[2] ?? "0", 10);
    if (major < 2 || (major === 2 && minor < 20)) {
      return {
        name: "git",
        status: "error",
        message: `git ${major}.${minor} found; git >= 2.20 required`,
      };
    }
    return { name: "git", status: "ok", message: `git ${stdout.trim().split(" ")[2] ?? "ok"}` };
  } catch {
    return { name: "git", status: "error", message: "git not found on PATH" };
  }
}

async function checkOrphanSessions(): Promise<DoctorCheck> {
  try {
    const sessions = await listSessions();
    const vrSessions = sessions.filter((s) => s.startsWith("vr-"));
    const projects = getAllProjects();
    const knownTmuxNames = new Set(
      projects.flatMap((p) =>
        p.worktrees.flatMap((w) => w.sessions.map((s) => s.tmuxName)),
      ),
    );

    const orphans = vrSessions.filter((s) => !knownTmuxNames.has(s));
    if (orphans.length > 0) {
      return {
        name: "orphan-sessions",
        status: "warn",
        message: `Found ${orphans.length} orphan tmux session(s): ${orphans.join(", ")}. Run 'tmux kill-session -t <name>' to clean up.`,
      };
    }
    return { name: "orphan-sessions", status: "ok", message: "No orphan tmux sessions" };
  } catch {
    return { name: "orphan-sessions", status: "warn", message: "Could not check tmux sessions (tmux not running?)" };
  }
}

async function checkOrphanWorktrees(): Promise<DoctorCheck> {
  const orphans: string[] = [];
  const projects = getAllProjects();
  for (const project of projects) {
    for (const wt of project.worktrees) {
      const wtPath = getWorktreePath(project.id, wt.id);
      try {
        await access(wtPath);
      } catch {
        orphans.push(`${project.id}/${wt.id} (expected at ${wtPath})`);
      }
    }
  }
  if (orphans.length > 0) {
    return {
      name: "orphan-worktrees",
      status: "warn",
      message: `Manifest references missing worktree directories:\n${orphans.join("\n")}`,
    };
  }
  return { name: "orphan-worktrees", status: "ok", message: "All worktree directories exist" };
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // tmux
  checks.push(
    (await checkBinary("tmux"))
      ? { name: "tmux", status: "ok", message: "tmux found on PATH" }
      : { name: "tmux", status: "error", message: "tmux not found on PATH" },
  );

  // git version
  checks.push(await checkGitVersion());

  // Plugin binaries (warn if missing)
  for (const plugin of ["claude", "cursor", "opencode"]) {
    const found = await checkBinary(plugin);
    checks.push({
      name: `plugin-${plugin}`,
      status: found ? "ok" : "warn",
      message: found ? `${plugin} found on PATH` : `${plugin} not found on PATH (plugin unavailable)`,
    });
  }

  // Orphan tmux sessions
  checks.push(await checkOrphanSessions());

  // Orphan worktree dirs
  checks.push(await checkOrphanWorktrees());

  return checks;
}
