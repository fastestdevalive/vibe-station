/**
 * GitHub PR lookup for the VCS tool tab.
 *
 * Deliberately does NOT shell out to the `gh` CLI: it isn't provisioned by
 * dev.Dockerfile or any other environment this daemon runs in (see the
 * "no PR integration" research that preceded this file — `git.ts`/`tmux.ts`
 * are the only existing examples of wrapping an external CLI, and both wrap
 * tools that ARE guaranteed present). Talking to the GitHub REST API
 * directly needs nothing beyond network access, which the daemon already has
 * for `fetchOrigin()`.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  author: string | null;
}

/** Returns the `origin` remote URL for a repo, or null if there is none. */
export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      env: { ...process.env },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Parses `owner/repo` out of a GitHub remote URL. Handles the common forms:
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo.git`,
 * `https://github.com/owner/repo`, `ssh://git@github.com/owner/repo.git`.
 * Returns null for non-GitHub remotes (GitHub Enterprise, GitLab, etc. are
 * out of scope for now).
 */
export function parseGithubRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
    /^(?:https?|ssh):\/\/(?:git@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/,
  ];
  for (const re of patterns) {
    const m = remoteUrl.trim().match(re);
    if (m) return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, "") };
  }
  return null;
}

interface CacheEntry {
  value: PrInfo | null;
  expiresAt: number;
}

// Keyed by `${owner}/${repo}#${branch}`. Unauthenticated GitHub API calls are
// capped at 60/hr per IP — a short TTL keeps the VCS tab responsive (each
// manual refresh / worktree switch would otherwise burn a call) without
// requiring the caller to build its own polling/caching layer.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

/**
 * Looks up the most relevant open-or-recently-updated PR for `branch` in
 * `owner/repo` via the GitHub REST API. Returns null if there's no PR, the
 * repo/branch can't be resolved, or the request fails (rate limit, no
 * network, private repo without a token, etc.) — this is a "nice to have"
 * annotation on the commit graph, never a hard failure.
 */
export async function fetchPrForBranch(
  owner: string,
  repo: string,
  branch: string,
): Promise<PrInfo | null> {
  const key = `${owner}/${repo}#${branch}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await fetchPrForBranchUncached(owner, repo, branch);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Test-only: clears the module-level PR cache. Matches the `_clearStoreForTest`/
 * `_resetModesCacheForTest` convention used elsewhere in this codebase for
 * module-level test state. */
export function _clearPrCacheForTest(): void {
  cache.clear();
}

async function fetchPrForBranchUncached(
  owner: string,
  repo: string,
  branch: string,
): Promise<PrInfo | null> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "vibe-station",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    // `state=all` + head filter: most recent PR for the branch, whether
    // open, merged, or closed-without-merge — the VCS tab wants to show
    // "was there ever a PR" state, not just "is one currently open".
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(branch)}&state=all&per_page=1&sort=created&direction=desc`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{
      number: number;
      html_url: string;
      title: string;
      state: string;
      draft: boolean;
      merged_at: string | null;
      user: { login: string } | null;
    }>;
    const pr = list[0];
    if (!pr) return null;
    return {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      state: pr.state === "closed" ? "closed" : "open",
      merged: pr.merged_at != null,
      draft: pr.draft,
      author: pr.user?.login ?? null,
    };
  } catch {
    return null;
  }
}
