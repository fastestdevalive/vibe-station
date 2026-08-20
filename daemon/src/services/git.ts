/**
 * Git wrappers used by the daemon.
 * All functions shell out to the `git` CLI using execFile for security.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const execFile = promisify(execFileCb);

/**
 * Run a git command safely using execFile (no shell interpolation).
 * This prevents shell injection attacks from user-supplied paths/branches.
 */
async function runGit(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, env: { ...process.env } });
  return stdout.trim();
}

/**
 * Like `runGit`, but returns raw untrimmed stdout. `runGit`'s `.trim()`
 * strips leading/trailing whitespace off the WHOLE string, not per line —
 * harmless for most commands, but `git submodule status`'s clean-status
 * lines start with a significant leading space (the status flag column),
 * which `.trim()` would silently eat off the first line only, corrupting
 * just that one line's parse. Used by `listSubmodules`.
 */
async function runGitRaw(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, env: { ...process.env } });
  return stdout;
}

/** Returns true if `dir` is inside a git repository. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(join(dir, ".git")).catch(async () => {
      // Could be a worktree or a .git file instead of dir
      await runGit(["-C", dir, "rev-parse", "--git-dir"]);
    });
    await runGit(["-C", dir, "rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if `dir`'s HEAD resolves to a commit, i.e. the repo has at
 * least one commit. Used to describe accurately what `project-setup.sh` will
 * do to an already-git directory: it runs `git add -A && git commit` whenever
 * HEAD doesn't resolve, even if the directory is already a repo.
 */
export async function hasCommits(dir: string): Promise<boolean> {
  try {
    await runGit(["-C", dir, "rev-parse", "--verify", "HEAD"]);
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
    const ref = await runGit(["-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD"]);
    // Returns e.g. "refs/remotes/origin/main"
    const parts = ref.split("/");
    const branch = parts[parts.length - 1];
    if (branch) return branch;
  } catch {
    // no remote
  }

  // 2. "master" exists locally
  try {
    await runGit(["-C", repoPath, "rev-parse", "--verify", "master"]);
    return "master";
  } catch {
    // doesn't exist
  }

  // 3. "main" exists locally
  try {
    await runGit(["-C", repoPath, "rev-parse", "--verify", "main"]);
    return "main";
  } catch {
    // doesn't exist
  }

  // 4. First branch in `git branch --list`
  try {
    const output = await runGit(["-C", repoPath, "branch", "--list"]);
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
    await runGit(["-C", repoPath, "rev-parse", "--verify", branch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * List local branch names in the repo, sorted by most-recent commit first.
 */
export async function listBranches(repoPath: string): Promise<string[]> {
  const out = await runGit([
    "-C", repoPath,
    "branch", "--list",
    "--sort=-committerdate",
    "--format=%(refname:short)",
  ]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Returns the full SHA of `ref` in the repo. */
export async function revParse(repoPath: string, ref: string): Promise<string> {
  return runGit(["-C", repoPath, "rev-parse", ref]);
}

/**
 * Resolves the *current* fork point between `HEAD` and `baseBranch` in the
 * given worktree (`git merge-base HEAD <baseBranch>`), falling back to
 * `fallbackBaseSha` (the worktree's stored, creation-time `baseSha`) if
 * `baseBranch` doesn't resolve — e.g. it was deleted/renamed upstream.
 *
 * A worktree's stored `baseSha` is captured once, at creation time, and
 * never updated. If the branch is later synced/rebased onto an advancing
 * base branch (a normal, expected workflow for long-running branches), the
 * true fork point moves forward but the stored value doesn't — every commit
 * the base branch picked up since creation then reads as "unique to this
 * branch" wherever `baseSha` is used for branch-scoped diffs/commit lists.
 * Recomputing the merge-base live avoids that drift. Returns null if neither
 * `baseBranch` nor the fallback resolves (e.g. a corrupted/pruned repo).
 */
export async function resolveBaseSha(
  repoPath: string,
  baseBranch: string | null | undefined,
  fallbackBaseSha?: string | null,
): Promise<string | null> {
  if (baseBranch) {
    try {
      return await runGit(["-C", repoPath, "merge-base", "HEAD", baseBranch], repoPath);
    } catch {
      // baseBranch ref doesn't resolve (deleted/renamed) — fall through.
    }
  }
  if (fallbackBaseSha) {
    try {
      // `cat-file -e` checks the object actually exists in the odb — unlike
      // `rev-parse --verify`, which accepts any syntactically well-formed
      // 40-hex string as a "valid" revision even if no such object exists.
      await runGit(["-C", repoPath, "cat-file", "-e", fallbackBaseSha], repoPath);
      return fallbackBaseSha;
    } catch {
      // stored SHA no longer resolves either (pruned) — give up.
    }
  }
  return null;
}

/** Add a git worktree with a new branch. */
export async function worktreeAdd(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  await runGit(["-C", repoPath, "worktree", "add", "-b", branch, worktreePath, baseBranch]);
}

/** Remove a git worktree (--force). */
export async function worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
  await runGit(["-C", repoPath, "worktree", "remove", "--force", worktreePath]);
}

/** Delete a local branch (--force). */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await runGit(["-C", repoPath, "branch", "-D", branch]);
}

/** Fetch a ref from origin (best-effort — swallows errors if no remote). */
export async function fetchOrigin(repoPath: string, ref: string): Promise<void> {
  try {
    await runGit(["-C", repoPath, "fetch", "origin", ref]);
  } catch {
    // no remote or network error — callers treat this as best-effort
  }
}

/** Initialize a new git repository in the given directory. */
export async function gitInit(dir: string): Promise<void> {
  await runGit(["init", dir]);
}

/** Standard .gitignore content for new projects. */
const DEFAULT_GITIGNORE = `.DS_Store
node_modules/
.env
.env.local
*.log
`;

/** Create a standard .gitignore file in the given directory. */
export async function createGitignore(dir: string): Promise<void> {
  await writeFile(join(dir, ".gitignore"), DEFAULT_GITIGNORE, "utf8");
}

export interface CommitLogEntry {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601, author date. */
  date: string;
  subject: string;
  /**
   * Full raw commit message (subject + body, `git log %B`), untrimmed of
   * internal newlines. Equal to `subject` for a commit with no body. Used by
   * the VCS tool tab's expand/collapse — `subject` alone is what's always
   * shown, `body` is revealed on click when it has more to show.
   */
  body: string;
  insertions: number;
  deletions: number;
  /** True if any changed file's diff couldn't be summarized as text (numstat reports "-"). */
  hasBinaryChanges: boolean;
  /**
   * True if this commit is reachable from HEAD but not from the `baseSha`
   * passed to `listCommits` (`git rev-list HEAD --not <baseSha>`). Callers
   * are expected to pass a freshly resolved fork point (see
   * `resolveBaseSha`, `git merge-base HEAD <baseBranch>`), not a value
   * cached from worktree-creation time — a cached value goes stale as soon
   * as the branch is synced/rebased onto an advancing base branch, at which
   * point every commit the base branch picked up since caching would
   * misread as "unique to this branch" here. Even with a freshly resolved
   * `baseSha` this is a proxy, not a guarantee: a force-pushed/rewritten
   * base branch can still produce a mismatch (harmless — it just doesn't
   * get collapsed). When `baseSha` isn't available at all (no worktree
   * record, base branch and stored fallback both unresolvable), every
   * commit is conservatively marked `true` so nothing is hidden. Used by
   * the VCS tool tab to collapse base-branch history by default.
   */
  isOnBranch: boolean;
}

// Record separator (0x1e) delimits commits; unit separator (0x1f) delimits fields
// within one commit's header line. Neither appears in normal commit metadata, so
// this is a safe, allocation-free way to split `git log` output without a
// per-commit subprocess.
const RS = "\x1e";
const US = "\x1f";

/** Full 40-hex-character git SHA. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * List commits reachable from HEAD (i.e. the worktree's full branch history —
 * same "show everything reachable from here" semantics as a bare `git log`),
 * most recent first, each annotated with its line-level diffstat
 * (insertions/deletions) versus its first parent. `--diff-merges=first-parent`
 * ensures merge commits get a real diffstat instead of git's default of
 * suppressing diff output for merges entirely.
 *
 * When `baseSha` is passed, each commit is also annotated with `isOnBranch`
 * (see `CommitLogEntry`), computed via `git rev-list --not <baseSha> HEAD` —
 * the same "unique to this branch" semantics `/changed-paths?scope=branch`
 * uses for `baseSha`-scoped diffs. Used by the VCS tool tab to render a
 * commit timeline and collapse base-branch history by default.
 */
export async function listCommits(
  repoPath: string,
  limit = 200,
  baseSha?: string,
): Promise<CommitLogEntry[]> {
  let stdout: string;
  try {
    stdout = await runGit(
      [
        "-C", repoPath,
        "log",
        `-n${limit}`,
        "--diff-merges=first-parent",
        `--pretty=format:${RS}%H${US}%h${US}%an${US}%ae${US}%aI${US}%s`,
        "--numstat",
      ],
      repoPath,
    );
  } catch {
    // Empty repo (no commits yet) or not a git dir — treat as no history.
    return [];
  }

  const blocks = stdout.split(RS).map((b) => b.trim()).filter(Boolean);
  const commits: CommitLogEntry[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines[0] ?? "";
    const [sha, shortSha, authorName, authorEmail, date, subject] = header.split(US);
    // `%H` is always exactly 40 hex chars and can never legitimately contain
    // the RS/US (0x1e/0x1f) bytes used as delimiters above — so a `sha` that
    // doesn't match this shape means a commit subject/body contained a
    // literal RS or US byte and fractured the block/field split. Drop the
    // resulting phantom entry rather than rendering corrupted data; this is
    // a defensive guard for adversarial/corrupted input, not an expected
    // path for normal commit messages.
    if (!sha || !FULL_SHA_RE.test(sha)) continue;

    let insertions = 0;
    let deletions = 0;
    let hasBinaryChanges = false;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const [added, removed] = line.split("\t");
      if (added === "-" || removed === "-") {
        hasBinaryChanges = true;
        continue;
      }
      const a = Number(added);
      const r = Number(removed);
      if (Number.isFinite(a)) insertions += a;
      if (Number.isFinite(r)) deletions += r;
    }

    commits.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      date: date ?? "",
      subject: subject ?? "",
      body: subject ?? "",
      insertions,
      deletions,
      hasBinaryChanges,
      // Provisional; overwritten below once the base-branch SHA set is known.
      isOnBranch: true,
    });
  }

  if (commits.length > 0) {
    await attachFullBodies(repoPath, commits);
  }

  if (baseSha) {
    const onBranchShas = await listShasNotIn(repoPath, baseSha);
    if (onBranchShas) {
      for (const commit of commits) {
        commit.isOnBranch = onBranchShas.has(commit.sha);
      }
    }
    // On failure (invalid/deleted baseSha ref), leave every commit's
    // provisional `isOnBranch: true` in place — fail open rather than hiding
    // history the user can't get back without knowing to expand it.
  }

  return commits;
}

/**
 * Returns the set of full SHAs reachable from `HEAD` but not from `baseSha`
 * (`git rev-list --not <baseSha> HEAD`), i.e. commits unique to the current
 * branch. Returns null on failure (e.g. `baseSha` no longer resolves because
 * the upstream ref was deleted) so callers can fail open.
 */
async function listShasNotIn(repoPath: string, baseSha: string): Promise<Set<string> | null> {
  try {
    // `--not` negates every ref that follows it, so `baseSha` must come
    // after `HEAD` — otherwise HEAD itself would be negated too, per
    // `git rev-list --help`'s "Reverses the meaning ... for all following
    // revision specifiers" semantics.
    const stdout = await runGit(["-C", repoPath, "rev-list", "HEAD", "--not", baseSha], repoPath);
    return new Set(stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Fills in `body` (full raw commit message, subject + description) for each
 * entry in `commits`, mutating them in place. A separate `git log` call
 * (no `--numstat`) keeps this immune to the numstat-line-splitting logic
 * above — `%B` can contain arbitrary embedded newlines, which would corrupt
 * the line-based parsing `listCommits` uses for the numstat block if mixed
 * into the same output. Splitting solely on the RS/US bytes (never on "\n")
 * sidesteps that entirely. Best-effort: on failure, every commit just keeps
 * `body === subject` (set by the caller before this runs).
 */
async function attachFullBodies(repoPath: string, commits: CommitLogEntry[]): Promise<void> {
  let stdout: string;
  try {
    stdout = await runGit(
      ["-C", repoPath, "log", `-n${commits.length}`, `--pretty=format:${RS}%H${US}%B`],
      repoPath,
    );
  } catch {
    return;
  }

  const bodies = new Map<string, string>();
  for (const block of stdout.split(RS)) {
    const sepIdx = block.indexOf(US);
    if (sepIdx === -1) continue;
    const sha = block.slice(0, sepIdx);
    const body = block.slice(sepIdx + 1).trim();
    if (sha) bodies.set(sha, body);
  }

  for (const commit of commits) {
    const body = bodies.get(commit.sha);
    if (body) commit.body = body;
  }
}

/** Check if git is available in PATH. */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await runGit(["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Info about one top-level submodule (`.gitmodules` entry), joined with its
 * pinned commit and `git submodule status` state. Deliberately top-level
 * only — nested submodules-of-submodules aren't walked (`--recursive` is NOT
 * used), since a nested path can't be mapped back to a `.gitmodules` branch
 * entry without recursive parsing, and that's out of scope for this view.
 */
export interface SubmoduleInfo {
  path: string;
  sha: string | null;
  shortSha: string | null;
  branch: string | null;
  subject: string | null;
  status: "clean" | "modified" | "out-of-date" | "uninitialized";
}

/**
 * Parses `.gitmodules`' `path`/`branch` pairs into `path -> branch`
 * (`branch` is `null` when a submodule section doesn't set one). Returns an
 * empty map when there's no `.gitmodules` file at all — most repos don't
 * have submodules, and that's not an error.
 */
async function parseGitmodulesBranches(repoPath: string): Promise<Map<string, string | null>> {
  const branchByPath = new Map<string, string | null>();
  let text: string;
  try {
    text = await readFile(join(repoPath, ".gitmodules"), "utf8");
  } catch {
    return branchByPath;
  }

  let curPath: string | null = null;
  let curBranch: string | null = null;
  const flush = () => {
    if (curPath) branchByPath.set(curPath, curBranch);
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^\[submodule\b/.test(line)) {
      flush();
      curPath = null;
      curBranch = null;
      continue;
    }
    const kv = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === "path") curPath = value!.trim();
    else if (key === "branch") curBranch = value!.trim();
  }
  flush();
  return branchByPath;
}

/** One parsed `git submodule status` line: leading status flag, the pinned
 *  40-hex SHA, and the submodule's path (relative to the repo root). */
function parseSubmoduleStatusLine(line: string): { flag: string; sha: string; path: string } | null {
  if (line.length < 42) return null;
  const flag = line[0]!;
  const sha = line.slice(1, 41);
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  // `path (describe)` or bare `path` — the describe suffix (when present) is
  // never needed here, only the path.
  const rest = line.slice(42);
  const path = rest.replace(/\s+\([^)]*\)\s*$/, "").trim();
  return { flag, sha, path };
}

/**
 * Lists this repo's top-level submodules (`.gitmodules` entries), each
 * joined with `git submodule status`'s pinned SHA/dirty-state and — for
 * initialized submodules — the pinned commit's subject line (read from the
 * submodule's own working tree via a nested `git log`). Used by the VCS tool
 * tab's "Submodules" section.
 *
 * - No `.gitmodules` (most repos): `[]`, no throw (Requirement 3a).
 * - An uninitialized submodule (`git submodule status`'s `-` prefix — no
 *   checked-out working tree) has no local repo to read a subject from:
 *   `sha` comes straight off the status line, `subject: null`,
 *   `status: "uninitialized"` (Requirement 3c).
 * - Any `git` invocation failure (corrupted repo, git error) fails open to
 *   `[]` rather than throwing — same contract as `listCommits`'s empty-repo
 *   case (Requirement 3d).
 */
export async function listSubmodules(repoPath: string): Promise<SubmoduleInfo[]> {
  const branchByPath = await parseGitmodulesBranches(repoPath);
  if (branchByPath.size === 0) return [];

  let stdout: string;
  try {
    stdout = await runGitRaw(["-C", repoPath, "submodule", "status"], repoPath);
  } catch {
    return [];
  }

  const result: SubmoduleInfo[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const parsed = parseSubmoduleStatusLine(line);
    if (!parsed) continue;
    const { flag, sha, path } = parsed;
    const shortSha = sha.slice(0, 7);
    const branch = branchByPath.get(path) ?? null;

    if (flag === "-") {
      result.push({ path, sha, shortSha, branch, subject: null, status: "uninitialized" });
      continue;
    }

    const submodulePath = join(repoPath, path);
    let subject: string | null = null;
    try {
      const s = await runGit(["-C", submodulePath, "log", "-1", "--format=%s"], submodulePath);
      subject = s || null;
    } catch {
      subject = null;
    }

    let status: SubmoduleInfo["status"];
    if (flag === "U") {
      status = "modified";
    } else {
      // `+` alone only means "checked-out SHA differs from the
      // superproject's pinned SHA" — it says nothing about the submodule's
      // working tree. A submodule sitting exactly at the pinned commit but
      // with uncommitted local edits gets flag `" "`, so the dirty check has
      // to run for that case too, not just `+` — otherwise a dirty
      // in-place submodule is wrongly reported "clean".
      let dirty = false;
      try {
        const porcelain = await runGit(["-C", submodulePath, "status", "--porcelain"], submodulePath);
        dirty = porcelain.trim().length > 0;
      } catch {
        dirty = false;
      }
      // `+` (out-of-date vs. the pin) takes precedence over a dirty working
      // tree when both are true — the mismatched SHA is the more urgent fact.
      if (flag === "+") status = "out-of-date";
      else if (dirty) status = "modified";
      else status = "clean";
    }

    result.push({ path, sha, shortSha, branch, subject, status });
  }
  return result;
}
