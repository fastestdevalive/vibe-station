/**
 * GitHub credential resolution (D2/D3 in
 * `.vibekit/reports/2026-08-16-pr-detection-broken-root-cause-and-fix.md`).
 *
 * Deliberately does NOT require the `gh` binary — `gh` is not provisioned by
 * `dev.Dockerfile` (or any environment this daemon runs in), so it can only
 * ever be an opportunistic last resort, never a hard dependency. Reads gh's
 * own *data file* (`~/.config/gh/hosts.yml`) instead, which holds a
 * per-login plaintext `oauth_token` on every host inspected so far (a
 * keyring-backed `hosts.yml` with no plaintext token is a known, unhandled
 * gap — see the research report's "Not checked" section).
 *
 * Credential chain, per account login (D3):
 *   1. `GH_TOKEN_<LOGIN>` env var (login upper-cased, `-`/`.` -> `_`)
 *   2. `GITHUB_TOKEN` / `GH_TOKEN` env var (generic — single-account fallback)
 *   3. `~/.config/gh/hosts.yml` -> `users.<login>.oauth_token`
 *   4. `gh auth token --user <login>`, only if `gh` happens to be on PATH
 *
 * `listAccounts()` never throws; it resolves to `[]` when nothing is found.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface GithubAccount {
  login: string;
  token: string;
}

function hostsYmlPath(): string {
  return join(process.env.GH_CONFIG_DIR || join(homedir(), ".config", "gh"), "hosts.yml");
}

/**
 * Minimal, purpose-built parser for gh's `hosts.yml` shape — not a general
 * YAML parser (no library dependency for one file format). Handles:
 *
 *   github.com:
 *       users:
 *           some-login:
 *               oauth_token: gho_xxxx
 *           other-login: {}
 *       oauth_token: gho_xxxx   # top-level = currently-active user's token
 *       user: some-login
 *
 * Returns every login found under the `github.com:` host's `users:` block
 * only — logins nested under a GitHub Enterprise Server host block (a
 * top-level key other than `github.com`) are deliberately excluded, since
 * their tokens are only valid against that GHES instance's API, not
 * `api.github.com`, and this daemon only ever talks to the latter.
 *
 * `oauth_token` when present (absent for keyring-backed logins).
 */
export function parseHostsYml(text: string): Array<{ login: string; token: string | null }> {
  const lines = text.split("\n");
  const found: Array<{ login: string; token: string | null }> = [];

  let currentHost: string | null = null;
  let inUsers = false;
  let usersIndent = -1;
  let currentLogin: string | null = null;
  let currentLoginIndent = -1;
  let currentToken: string | null = null;

  const flushCurrent = () => {
    if (currentLogin !== null && currentHost === "github.com") {
      found.push({ login: currentLogin, token: currentToken });
    }
    currentLogin = null;
    currentToken = null;
  };

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();

    // Top-level host block header, e.g. `github.com:` or a GHES hostname.
    if (indent === 0) {
      const hostMatch = /^([^:]+):\s*$/.exec(trimmed);
      if (hostMatch) {
        flushCurrent();
        inUsers = false;
        currentHost = hostMatch[1]!.trim();
        continue;
      }
    }

    if (trimmed === "users:") {
      flushCurrent();
      inUsers = true;
      usersIndent = indent;
      continue;
    }
    if (!inUsers) continue;

    if (indent <= usersIndent) {
      flushCurrent();
      inUsers = false;
      continue;
    }

    if (currentLogin === null || indent <= currentLoginIndent) {
      // Strip a trailing ` # comment` before matching — `login: # nickname`
      // is valid hosts.yml and previously failed to match at all, silently
      // dropping that login.
      const withoutComment = trimmed.replace(/\s+#.*$/, "");
      const m = /^([^:]+):\s*(\{\s*\})?\s*$/.exec(withoutComment);
      if (m) {
        flushCurrent();
        currentLogin = m[1]!.trim();
        currentLoginIndent = indent;
      }
      continue;
    }

    const tokenMatch = /^oauth_token:\s*(.+)$/.exec(trimmed);
    if (tokenMatch) {
      currentToken = tokenMatch[1]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  flushCurrent();
  return found;
}

async function readHostsYmlAccounts(): Promise<Array<{ login: string; token: string | null }>> {
  try {
    const text = await readFile(hostsYmlPath(), "utf8");
    return parseHostsYml(text);
  } catch {
    return [];
  }
}

async function isGhOnPath(): Promise<boolean> {
  try {
    await execFile("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function ghAuthTokenForUser(login: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("gh", ["auth", "token", "--user", login]);
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

function envTokenForLogin(login: string): string | undefined {
  const key = `GH_TOKEN_${login.toUpperCase().replace(/[-.]/g, "_")}`;
  return process.env[key];
}

/**
 * Resolves every GitHub account this daemon can act as, one token per login,
 * strongest source wins per the chain above. Cheap enough to call per poll
 * tick (one file read, no network) that no in-memory cache is needed here —
 * callers that want a stable view across a tick should call it once and
 * reuse the result.
 */
export async function listAccounts(): Promise<GithubAccount[]> {
  const tokens = new Map<string, string>();
  const knownLogins = new Set<string>();

  // 3. hosts.yml — establishes known logins even when a login has no
  //    plaintext token (keyring-backed), so step 4 still knows to try it.
  const hostsAccounts = await readHostsYmlAccounts();
  for (const { login, token } of hostsAccounts) {
    knownLogins.add(login);
    if (token) tokens.set(login, token);
  }

  // 2a. Generic GITHUB_TOKEN/GH_TOKEN — env wins over hosts.yml, but ONLY when
  //    there's a single account in play (covers the common solo-account case
  //    with no hosts.yml at all — synthetic "default" login). With >=2 known
  //    logins a single generic token cannot possibly be valid for all of
  //    them, so filling it in here is deferred to 2b below, AFTER step 4 has
  //    had a chance to resolve each login's own real token — see 2b for why.
  const generic = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (generic) {
    if (knownLogins.size === 0) {
      knownLogins.add("default");
      tokens.set("default", generic);
    } else if (knownLogins.size === 1) {
      for (const login of knownLogins) tokens.set(login, generic);
    }
  }

  // 1. GH_TOKEN_<LOGIN> — highest priority, per-account override.
  for (const login of knownLogins) {
    const perAccount = envTokenForLogin(login);
    if (perAccount) tokens.set(login, perAccount);
  }

  // 4. `gh auth token --user X` — only for logins still missing a token, and
  //    only if `gh` happens to be on PATH. Never required. Must run BEFORE
  //    2b below: a keyring-backed second login has no plaintext token in
  //    hosts.yml, so if 2b's generic-token fill ran first it would stamp the
  //    (wrong-for-this-login) generic token onto it and this step would then
  //    see it as already resolved and skip it — the exact wrong-token->404
  //    failure this fallback chain exists to avoid.
  const stillMissing = [...knownLogins].filter((login) => !tokens.has(login));
  if (stillMissing.length > 0 && (await isGhOnPath())) {
    for (const login of stillMissing) {
      const token = await ghAuthTokenForUser(login);
      if (token) tokens.set(login, token);
    }
  }

  // 2b. Generic GITHUB_TOKEN/GH_TOKEN, >=2-account fallback — only NOW, for
  //    logins that even `gh auth token --user` couldn't resolve a real token
  //    for. Still a guess (one token for every remaining login), but it's a
  //    last resort after every login-specific source has been tried, not a
  //    pre-emptive stamp that blocks a better source from running.
  if (generic && knownLogins.size >= 2) {
    for (const login of knownLogins) {
      if (!tokens.has(login)) tokens.set(login, generic);
    }
  }

  return [...tokens.entries()].map(([login, token]) => ({ login, token }));
}
