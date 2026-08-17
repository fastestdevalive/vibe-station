/**
 * GitHub PR lookup for the VCS tool tab + the PR poller.
 *
 * Deliberately does NOT shell out to the `gh` CLI: it isn't provisioned by
 * `dev.Dockerfile` or any other environment this daemon runs in. Talks to
 * the GitHub GraphQL API directly via `fetch`; credentials are resolved by
 * `./githubAuth.js` from env vars and gh's own config *file*
 * (`~/.config/gh/hosts.yml`), never by invoking `gh` unless it's already on
 * PATH and every other source came up empty (see `githubAuth.ts`).
 *
 * SSH remotes that use a host alias (`git@github-<login>:owner/repo`, a
 * common multi-account setup) are resolved by parsing `~/.ssh/config` in
 * TypeScript — never by shelling out to `ssh -G`, which isn't guaranteed
 * present either.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { listAccounts, type GithubAccount } from "./githubAuth.js";

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

export type PrLookupResult =
  | { kind: "pr"; pr: PrInfo }
  | { kind: "no_pr" }
  | { kind: "not_github" }
  | { kind: "no_credentials" }
  | {
      kind: "error";
      reason: "network" | "rate_limited" | "auth" | "api";
      message: string;
      retryAfterMs?: number;
    };

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

interface RawRemote {
  host: string;
  owner: string;
  repo: string;
}

/** Strips userinfo (`user:token@`) and a trailing `:port` off a captured
 *  host, e.g. `https://user:token@github.com/o/r.git` and
 *  `ssh://git@github.com:22/o/r.git` — both otherwise capture the wrong
 *  string as `host` and silently fail the GitHub check (N3). */
function stripUserinfoAndPort(host: string): string {
  const withoutUserinfo = host.includes("@") ? host.slice(host.lastIndexOf("@") + 1) : host;
  return withoutUserinfo.replace(/:\d+$/, "");
}

/** Captures `host`/`owner`/`repo` out of any remote URL shape, GitHub or not. */
function parseHostOwnerRepo(remoteUrl: string): RawRemote | null {
  const trimmed = remoteUrl.trim();
  const patterns = [
    /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/,
    /^(?:https?|ssh):\/\/(?:git@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return { host: stripUserinfoAndPort(m[1]!), owner: m[2]!, repo: m[3]!.replace(/\.git$/, "") };
  }
  return null;
}

// ── ~/.ssh/config parsing (D4/K2) — cached by the mtime of every file the
// parse actually visited (top-level config + every `Include`d file), so an
// edit to an `Include`d file invalidates the cache too, not just the
// top-level file. ──

interface SshConfigCache {
  /** path -> mtimeMs, for the top-level config file AND every `Include`d
   *  file the parse visited. */
  fileMtimes: Map<string, number>;
  hostMap: Map<string, string>;
}

let sshConfigCache: SshConfigCache | null = null;

function resolveIncludePath(raw: string, sshDir: string): string {
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  if (isAbsolute(cleaned)) return cleaned;
  if (cleaned.startsWith("~/")) return join(homedir(), cleaned.slice(2));
  return join(sshDir, cleaned);
}

/** Parses one `~/.ssh/config`-shaped file into `alias -> HostName`. Handles a
 *  single level of `Include` (D4/risk #2); no glob expansion, no `Match`.
 *  Records every successfully-read file's mtime into `fileMtimes` so the
 *  caller can key the cache off the whole dependency set, not just the
 *  top-level file. */
async function parseSshConfigFile(
  path: string,
  depth: number,
  sshDir: string,
  hostMap: Map<string, string>,
  fileMtimes: Map<string, number>,
): Promise<void> {
  if (depth > 1) return; // one Include level, per the locked design.
  let text: string;
  try {
    const st = await stat(path);
    text = await readFile(path, "utf8");
    fileMtimes.set(path, st.mtimeMs);
  } catch {
    return;
  }

  let currentHosts: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const spaceIdx = line.search(/\s/);
    const key = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toLowerCase();
    const value = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();

    if (key === "host") {
      currentHosts = value.split(/\s+/).filter(Boolean);
    } else if (key === "hostname") {
      for (const alias of currentHosts) {
        if (!alias.includes("*") && !alias.includes("?")) hostMap.set(alias, value);
      }
    } else if (key === "include") {
      for (const incRaw of value.split(/\s+/).filter(Boolean)) {
        // No glob expansion — literal-path Includes only.
        await parseSshConfigFile(resolveIncludePath(incRaw, sshDir), depth + 1, sshDir, hostMap, fileMtimes);
      }
    }
  }
}

async function statMtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** True iff every file the last parse visited (top-level + every `Include`)
 *  still has the mtime it had when parsed. */
async function isSshConfigCacheFresh(c: SshConfigCache): Promise<boolean> {
  for (const [path, mtimeMs] of c.fileMtimes) {
    if ((await statMtime(path)) !== mtimeMs) return false;
  }
  return true;
}

async function resolveSshAliasHost(alias: string): Promise<string | null> {
  const sshDir = join(homedir(), ".ssh");
  const configPath = join(sshDir, "config");

  if ((await statMtime(configPath)) == null) {
    sshConfigCache = null;
    return null;
  }

  if (!sshConfigCache || !(await isSshConfigCacheFresh(sshConfigCache))) {
    const hostMap = new Map<string, string>();
    const fileMtimes = new Map<string, number>();
    await parseSshConfigFile(configPath, 0, sshDir, hostMap, fileMtimes);
    sshConfigCache = { fileMtimes, hostMap };
  }
  return sshConfigCache.hostMap.get(alias) ?? null;
}

/**
 * Replaces `parseGithubRepo`. Relaxed regex captures any host, then resolves
 * whether it's actually GitHub: a literal `github.com` host short-circuits;
 * otherwise the alias is looked up in `~/.ssh/config` for a `HostName`
 * ending in `github.com`, falling back to the `/^github[-.]/i` naming
 * heuristic (D4). The returned `host` is always the *raw* host/alias from
 * the remote URL, unchanged — only whether the remote resolves to GitHub is
 * decided here.
 */
export async function resolveGithubRemote(
  remoteUrl: string,
): Promise<{ host: string; owner: string; repo: string } | null> {
  const parsed = parseHostOwnerRepo(remoteUrl);
  if (!parsed) return null;
  if (parsed.host === "github.com") return parsed;

  const resolvedHostName = await resolveSshAliasHost(parsed.host);
  if (resolvedHostName && /(^|\.)github\.com$/i.test(resolvedHostName)) return parsed;

  if (/^github[-.]/i.test(parsed.host)) return parsed;

  return null;
}

function entryKey(e: { owner: string; repo: string; branch: string }): string {
  return `${e.owner}/${e.repo}#${e.branch}`;
}

interface GraphQLPrNode {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  merged: boolean;
  author: { login: string } | null;
}

function toPrInfo(node: GraphQLPrNode): PrInfo {
  return {
    number: node.number,
    url: node.url,
    title: node.title,
    state: node.state === "OPEN" ? "open" : "closed",
    merged: node.merged,
    draft: node.isDraft,
    author: node.author?.login ?? null,
  };
}

function classifyHttpError(status: number, headers: Headers): PrLookupResult {
  if (status === 401) {
    return { kind: "error", reason: "auth", message: `GitHub API auth failed (${status})` };
  }
  if (status === 403) {
    const remaining = headers.get("x-ratelimit-remaining");
    const retryAfterHeader = headers.get("retry-after");
    const resetHeader = headers.get("x-ratelimit-reset");
    if (remaining === "0" || retryAfterHeader || resetHeader) {
      let retryAfterMs: number | undefined;
      if (retryAfterHeader) retryAfterMs = Number(retryAfterHeader) * 1000;
      else if (resetHeader) retryAfterMs = Math.max(0, Number(resetHeader) * 1000 - Date.now());
      return {
        kind: "error",
        reason: "rate_limited",
        message: `GitHub API rate limited (${status})`,
        ...(retryAfterMs != null && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
      };
    }
    return { kind: "error", reason: "auth", message: `GitHub API forbidden (${status})` };
  }
  return { kind: "error", reason: "api", message: `GitHub API error (${status})` };
}

/** Sentinel: this alias came back `NOT_FOUND` for this account (wrong
 *  account, or the repo genuinely doesn't exist) — never surfaced to
 *  callers, only used internally to decide whether an account "owns" a
 *  repo's owner (K3/D4b). */
const NOT_FOUND = Symbol("not_found");

/** N2: per-account rate-limit gate. Set from a 403's `retryAfterMs`;
 *  consulted before every subsequent request for that account so the poller
 *  doesn't keep burning requests into the same rate-limit window — it was
 *  computed and never read before this fix. */
const rateLimitedUntil = new Map<string, number>();

/** Maps a top-level GraphQL `errors[]` array (no usable `data` at all — the
 *  shape GitHub uses for rate-limiting, internal errors, and SAML-enforced
 *  `FORBIDDEN`) to a definitive `{kind:"error"}`. Never `no_pr` — a 200 with
 *  errors and no data is not "no PR exists" (B1: this was the exact bug that
 *  wiped real PR state across every worktree of an owner). */
function mapTopLevelGraphQLErrors(
  errors: Array<{ type?: string; message?: string }> | undefined,
): PrLookupResult {
  const first = errors?.[0];
  const reason = first?.type === "RATE_LIMITED" ? "rate_limited" : "api";
  const message = first?.message
    ? `GitHub GraphQL error: ${first.message}`
    : "GitHub GraphQL API returned no data";
  return { kind: "error", reason, message };
}

async function queryAccountGraphQL(
  account: GithubAccount,
  entries: Array<{ owner: string; repo: string; branch: string }>,
): Promise<
  | { ok: true; perEntry: Map<string, PrLookupResult | typeof NOT_FOUND> }
  | { ok: false; error: PrLookupResult }
> {
  const gateUntil = rateLimitedUntil.get(account.login);
  if (gateUntil != null && gateUntil > Date.now()) {
    return {
      ok: false,
      error: {
        kind: "error",
        reason: "rate_limited",
        message: `GitHub API rate limited for ${account.login} until ${new Date(gateUntil).toISOString()}`,
        retryAfterMs: gateUntil - Date.now(),
      },
    };
  }

  const alias = (i: number) => `repo${i}`;
  const fields = entries
    .map(
      (e, i) => `${alias(i)}: repository(owner: ${JSON.stringify(e.owner)}, name: ${JSON.stringify(e.repo)}) {
    pullRequests(headRefName: ${JSON.stringify(e.branch)}, last: 1, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number url title state isDraft merged author { login } }
    }
  }`,
    )
    .join("\n");
  const query = `query { ${fields} }`;

  let res: Response;
  try {
    res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
        "User-Agent": "vibe-station",
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "error",
        reason: "network",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (!res.ok) {
    const classified = classifyHttpError(res.status, res.headers);
    if (classified.kind === "error" && classified.reason === "rate_limited" && classified.retryAfterMs != null) {
      rateLimitedUntil.set(account.login, Date.now() + classified.retryAfterMs);
    }
    return { ok: false, error: classified };
  }

  let body: {
    data?: Record<string, { pullRequests: { nodes: GraphQLPrNode[] } } | null> | null;
    errors?: Array<{ path?: Array<string | number>; type?: string; message?: string }>;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, error: { kind: "error", reason: "api", message: "Invalid JSON from GitHub GraphQL API" } };
  }

  // B1: GitHub signals rate-limiting, internal errors, and SAML-enforced
  // FORBIDDEN as HTTP 200 with `errors[]` and NO `data` at all. Previously
  // every alias fell through the `!repoData` branch below and was laundered
  // into the internal `NOT_FOUND` sentinel, which the caller then converts
  // to a definitive `no_pr` — wiping every worktree's real PR state for the
  // whole rate-limit window. A response with no `data` can never mean "no
  // PR exists"; it must surface as a transport-level error so the poller
  // holds the prior state (D8/R4).
  if (body.data == null) {
    return { ok: false, error: mapTopLevelGraphQLErrors(body.errors) };
  }

  const notFoundAliases = new Set<string>();
  const erroredAliases = new Map<string, string>();
  for (const err of body.errors ?? []) {
    const path0 = err.path?.[0];
    if (typeof path0 !== "string") continue;
    if (err.type === "NOT_FOUND") notFoundAliases.add(path0);
    else erroredAliases.set(path0, err.type ?? "UNKNOWN");
  }

  const perEntry = new Map<string, PrLookupResult | typeof NOT_FOUND>();
  entries.forEach((e, i) => {
    const a = alias(i);
    const k = entryKey(e);
    const repoData = body.data?.[a];
    if (notFoundAliases.has(a)) {
      perEntry.set(k, NOT_FOUND);
      return;
    }
    if (!repoData) {
      // A null alias with NO matching NOT_FOUND error (partial-failure
      // responses can null out some aliases while others are RATE_LIMITED /
      // INTERNAL / FORBIDDEN, or an alias can simply be missing with no
      // error entry at all) must never be laundered into `no_pr` — surface
      // it as a definitive error so the poller holds the prior state (B1).
      const errType = erroredAliases.get(a);
      perEntry.set(k, {
        kind: "error",
        reason: errType === "RATE_LIMITED" ? "rate_limited" : "api",
        message: errType
          ? `GitHub GraphQL error for ${e.owner}/${e.repo}: ${errType}`
          : `GitHub GraphQL returned no data for ${e.owner}/${e.repo}`,
      });
      return;
    }
    const node = repoData.pullRequests.nodes[0];
    perEntry.set(k, node ? { kind: "pr", pr: toPrInfo(node) } : { kind: "no_pr" });
  });

  return { ok: true, perEntry };
}

/** Cached `owner -> login` — avoids re-probing which account can see a given
 *  owner's repos on every tick (K3/D4b). */
const ownerAccountCache = new Map<string, string>();

/** Orders candidate accounts for probing an owner: the login that matches
 *  the owner first (common single-account-per-org case), then the rest. */
function orderAccountsForOwner(accounts: GithubAccount[], owner: string): GithubAccount[] {
  const lower = owner.toLowerCase();
  return [...accounts].sort((a, b) => {
    const aMatch = a.login.toLowerCase() === lower ? 0 : 1;
    const bMatch = b.login.toLowerCase() === lower ? 0 : 1;
    return aMatch - bMatch;
  });
}

/**
 * Looks up the most recent PR for each `{owner, repo, branch}` entry, one
 * aliased GraphQL query per GitHub *account* (D1/K4/N1) — steady-state cost
 * is O(distinct credentialed accounts actually in use), not O(distinct
 * owners). Owners whose serving account is already known (`ownerAccountCache`)
 * are merged into a single query per account regardless of how many distinct
 * owners that account serves; only an owner seen for the first time still
 * probes candidate accounts one owner at a time (unavoidable — which account
 * can see it isn't known yet).
 */
export async function fetchPrsForBranches(
  entries: Array<{ owner: string; repo: string; branch: string }>,
): Promise<Map<string, PrLookupResult>> {
  const results = new Map<string, PrLookupResult>();
  if (entries.length === 0) return results;

  const accounts = await listAccounts();
  if (accounts.length === 0) {
    for (const e of entries) results.set(entryKey(e), { kind: "no_credentials" });
    return results;
  }
  const accountByLogin = new Map(accounts.map((a) => [a.login, a] as const));

  const byOwner = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = byOwner.get(e.owner);
    if (list) list.push(e);
    else byOwner.set(e.owner, [e]);
  }

  // N1: split into owners whose serving account is already cached (merge by
  // account, one query total per account) vs. owners seen for the first
  // time (still probed one owner at a time).
  const cachedByLogin = new Map<string, typeof entries>();
  const uncachedOwners: string[] = [];
  for (const [owner, ownerEntries] of byOwner) {
    const cachedLogin = ownerAccountCache.get(owner);
    if (cachedLogin && accountByLogin.has(cachedLogin)) {
      const list = cachedByLogin.get(cachedLogin);
      if (list) list.push(...ownerEntries);
      else cachedByLogin.set(cachedLogin, [...ownerEntries]);
    } else {
      uncachedOwners.push(owner);
    }
  }

  await Promise.all([
    ...[...cachedByLogin.entries()].map(async ([login, accountEntries]) => {
      const account = accountByLogin.get(login)!;
      const queried = await queryAccountGraphQL(account, accountEntries);
      if (!queried.ok) {
        // Same rationale as the uncached path below: a transport-level
        // failure is not "wrong account" — surface it immediately (D8).
        for (const e of accountEntries) results.set(entryKey(e), queried.error);
        return;
      }
      // Already-known-good account: commit unconditionally, exactly like the
      // single-candidate cached path used to (a NOT_FOUND for one repo under
      // a verified account is that repo's own state, not a wrong-account signal).
      for (const [k, v] of queried.perEntry) {
        results.set(k, v === NOT_FOUND ? { kind: "no_pr" } : v);
      }
    }),
    ...uncachedOwners.map(async (owner) => {
      const ownerEntries = byOwner.get(owner)!;
      const candidates = orderAccountsForOwner(accounts, owner);

      for (const account of candidates) {
        const queried = await queryAccountGraphQL(account, ownerEntries);
        if (!queried.ok) {
          // A transport-level failure (network/rate-limit/auth/api) is not
          // "wrong account" — trying another candidate wouldn't help and
          // would burn extra quota, so surface it immediately (D8: hold on
          // non-definitive results, never silently retry-as-guess).
          for (const e of ownerEntries) results.set(entryKey(e), queried.error);
          return;
        }

        const anyFound = [...queried.perEntry.values()].some((v) => v !== NOT_FOUND);
        if (anyFound) {
          ownerAccountCache.set(owner, account.login);
          for (const [k, v] of queried.perEntry) {
            results.set(k, v === NOT_FOUND ? { kind: "no_pr" } : v);
          }
          return;
        }
        // Every repo for this owner NOT_FOUND under this account — try the next.
      }

      // No candidate account could see any repo for this owner.
      for (const e of ownerEntries) {
        results.set(entryKey(e), {
          kind: "error",
          reason: "auth",
          message: `No credentialed GitHub account can access ${owner}`,
        });
      }
    }),
  ]);

  return results;
}

interface CacheEntry {
  value: PrLookupResult;
  expiresAt: number;
}

// Keyed by `${owner}/${repo}#${branch}`. K8: 5s TTL — short enough that the
// 10s poll interval isn't defeated by a stale cached value, long enough that
// a manual VCS-tab refresh right after a poll tick doesn't double the call.
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, CacheEntry>();

/**
 * Single-entry wrapper over `fetchPrsForBranches`, for callers (the VCS tool
 * tab route) that only ever want one branch's result. `error` results are
 * never cached — a transient failure must not "stick" past its own tick.
 */
export async function fetchPrForBranch(
  owner: string,
  repo: string,
  branch: string,
): Promise<PrLookupResult> {
  const key = entryKey({ owner, repo, branch });
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const results = await fetchPrsForBranches([{ owner, repo, branch }]);
  const value: PrLookupResult = results.get(key) ?? {
    kind: "error",
    reason: "api",
    message: "No result returned for this branch",
  };
  if (value.kind !== "error") {
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return value;
}

/** Test-only: clears the module-level PR + owner->account caches. Matches
 *  the `_clearStoreForTest`/`_resetModesCacheForTest` convention used
 *  elsewhere in this codebase for module-level test state. */
export function _clearPrCacheForTest(): void {
  cache.clear();
  ownerAccountCache.clear();
  rateLimitedUntil.clear();
  sshConfigCache = null;
}
