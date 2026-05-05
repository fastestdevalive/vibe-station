// @ts-nocheck
/**
 * Git wrappers used by the daemon.
 * All functions shell out to the `git` CLI.
 */
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execCb);

async function run(cmd: string, cwd?: string): Promise<string> {
  const { stdout } = await exec(cmd, { cwd, env: { ...process.env } });
  return stdout.trim();
}

/** Returns true if `dir` is inside a git repository. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(join(dir, ".git")).catch(async () => {
      // Could be a worktree or a .git file instead of dir
      await run(`git -C "${dir}" rev-parse --git-dir`);
    });
    await run(`git -C "${dir}" rev-parse --git-dir`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the default branch for a repo using the fallback chain from
 * HIGH-LEVEL-DESIGN.md §5:
 * 1. git symbolic-ref refs/remotes/origin/HEAD
 * 2. local branch named "master" exists
 * 3. local branch named "main" exists
 * 4. first branch in `git branch --list`
 * Returns null if nothing can be determined.
 */
export async function detectDefaultBranch(repoPath: string): Promise<string | null> {
  // 1. Try origin/HEAD symref
  try {
    const ref = await run(`git -C "${repoPath}" symbolic-ref refs/remotes/origin/HEAD`);
    // Returns e.g. "refs/remotes/origin/main"
    const parts = ref.split("/");
    const branch = parts[parts.length - 1];
    if (branch) return branch;
  } catch {
    // no remote
  }

  // 2. "master" exists locally
  try {
    await run(`git -C "${repoPath}" rev-parse --verify master`);
    return "master";
  } catch {
    // doesn't exist
  }

  // 3. "main" exists locally
  try {
    await run(`git -C "${repoPath}" rev-parse --verify main`);
    return "main";
  } catch {
    // doesn't exist
  }

  // 4. First branch in `git branch --list`
  try {
    const output = await run(`git -C "${repoPath}" branch --list`);
    const lines = output
      .split("\n")
      .map((l) => l.replace(/^\*?\s+/, "").trim())
      .filter(Boolean);
    if (lines[0]) return lines[0];
  } catch {
    // empty repo
  }

  return null;
}

/** Returns true if `branch` exists locally in the repo at `repoPath`. */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await run(`git -C "${repoPath}" rev-parse --verify "${branch}"`);
    return true;
  } catch {
    return false;
  }
}

/** Returns the full SHA of `ref` in the repo. */
export async function revParse(repoPath: string, ref: string): Promise<string> {
  return run(`git -C "${repoPath}" rev-parse "${ref}"`);
}

/** Add a git worktree with a new branch. */
export async function worktreeAdd(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  await run(
    `git -C "${repoPath}" worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`,
  );
}

/** Remove a git worktree (--force). */
export async function worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
  await run(`git -C "${repoPath}" worktree remove --force "${worktreePath}"`);
}

/** Delete a local branch (--force). */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await run(`git -C "${repoPath}" branch -D "${branch}"`);
}

/** Fetch a ref from origin (best-effort — swallows errors if no remote). */
export async function fetchOrigin(repoPath: string, ref: string): Promise<void> {
  try {
    await run(`git -C "${repoPath}" fetch origin "${ref}"`);
  } catch {
    // no remote or network error — callers treat this as best-effort
  }
}
