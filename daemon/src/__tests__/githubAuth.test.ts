/**
 * `daemon/src/services/githubAuth.ts` — GitHub credential resolution, no
 * `gh` binary dependency (D2/D3). Uses a real temp `~/.config/gh/hosts.yml`-
 * shaped file (via `GH_CONFIG_DIR`) rather than mocking `node:fs`, so the
 * parser itself is exercised end to end; `gh` is never actually invoked
 * because the tests never leave the fallback chain's last step reachable
 * with a real PATH lookup succeeding (PATH is cleared).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAccounts, parseHostsYml } from "../services/githubAuth.js";

describe("parseHostsYml", () => {
  it("extracts login + oauth_token for every user under every host's users: block", () => {
    const text = `github.com:
    users:
        techwithnidhi:
            oauth_token: gho_aaa
        fastestdevalive:
            oauth_token: gho_bbb
    git_protocol: ssh
    user: techwithnidhi
    oauth_token: gho_aaa
`;
    expect(parseHostsYml(text)).toEqual([
      { login: "techwithnidhi", token: "gho_aaa" },
      { login: "fastestdevalive", token: "gho_bbb" },
    ]);
  });

  it("returns a null token for a keyring-backed login with no plaintext oauth_token", () => {
    const text = `github.com:
    users:
        keyring-user: {}
    git_protocol: https
`;
    expect(parseHostsYml(text)).toEqual([{ login: "keyring-user", token: null }]);
  });

  it("returns [] for empty or unrelated content", () => {
    expect(parseHostsYml("")).toEqual([]);
    expect(parseHostsYml("some_other_key: value\n")).toEqual([]);
  });

  it("excludes logins nested under a GHES host block — their tokens aren't valid against api.github.com", () => {
    const text = `my-ghes.example.com:
    users:
        ghes-user:
            oauth_token: ghes_token
github.com:
    users:
        real-user:
            oauth_token: gho_real
`;
    expect(parseHostsYml(text)).toEqual([{ login: "real-user", token: "gho_real" }]);
  });

  it("handles a login line with a trailing comment (`login: # nickname`)", () => {
    const text = `github.com:
    users:
        commented-login: # some nickname
            oauth_token: gho_commented
`;
    expect(parseHostsYml(text)).toEqual([{ login: "commented-login", token: "gho_commented" }]);
  });
});

describe("listAccounts", () => {
  let configDir: string;
  const originalEnv = { ...process.env };
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "vst-githubauth-test-"));
    process.env.GH_CONFIG_DIR = configDir;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GH_TOKEN_")) delete process.env[key];
    }
    // Keep `gh auth token` unreachable — listAccounts must never throw or
    // hang trying to shell out when nothing else resolves a login's token.
    process.env.PATH = "/nonexistent-bin-dir";
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    process.env.PATH = originalPath;
    await rm(configDir, { recursive: true, force: true });
  });

  it("Requirement 1.T2 — [] when neither env nor hosts.yml exist (no throw)", async () => {
    await expect(listAccounts()).resolves.toEqual([]);
  });

  it("Requirement 1.T2 — a generic GITHUB_TOKEN env var wins over hosts.yml's token for the same login", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "hosts.yml"),
      `github.com:
    users:
        solo-user:
            oauth_token: gho_from_file
`,
    );
    process.env.GITHUB_TOKEN = "gho_from_env";

    const accounts = await listAccounts();
    expect(accounts).toEqual([{ login: "solo-user", token: "gho_from_env" }]);
  });

  it("hosts.yml alone resolves accounts when no env token is set", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "hosts.yml"),
      `github.com:
    users:
        techwithnidhi:
            oauth_token: gho_aaa
        fastestdevalive:
            oauth_token: gho_bbb
`,
    );

    const accounts = await listAccounts();
    expect(accounts.sort((a, b) => a.login.localeCompare(b.login))).toEqual([
      { login: "fastestdevalive", token: "gho_bbb" },
      { login: "techwithnidhi", token: "gho_aaa" },
    ]);
  });

  it("GH_TOKEN_<LOGIN> overrides hosts.yml's token for that one login only", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "hosts.yml"),
      `github.com:
    users:
        techwithnidhi:
            oauth_token: gho_aaa
        fastestdevalive:
            oauth_token: gho_bbb
`,
    );
    process.env.GH_TOKEN_TECHWITHNIDHI = "gho_override";

    const accounts = await listAccounts();
    const byLogin = new Map(accounts.map((a) => [a.login, a.token]));
    expect(byLogin.get("techwithnidhi")).toBe("gho_override");
    expect(byLogin.get("fastestdevalive")).toBe("gho_bbb");
  });

  it("B3 — a generic GITHUB_TOKEN does NOT overwrite either login's existing hosts.yml token when there are TWO accounts", async () => {
    // Regression: stamping a single generic token onto every known login
    // silently breaks whichever account it isn't actually for — that
    // account's private repos 404 under the wrong token, indistinguishable
    // from "no PR exists" (the exact bug this whole feature exists to fix).
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "hosts.yml"),
      `github.com:
    users:
        techwithnidhi:
            oauth_token: gho_aaa
        fastestdevalive:
            oauth_token: gho_bbb
`,
    );
    process.env.GITHUB_TOKEN = "gho_generic_should_not_apply";

    const accounts = await listAccounts();
    const byLogin = new Map(accounts.map((a) => [a.login, a.token]));
    expect(byLogin.get("techwithnidhi")).toBe("gho_aaa");
    expect(byLogin.get("fastestdevalive")).toBe("gho_bbb");
  });

  it("B3 — a generic GITHUB_TOKEN DOES fill in a two-account login that has no token of its own (keyring-backed)", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "hosts.yml"),
      `github.com:
    users:
        techwithnidhi:
            oauth_token: gho_aaa
        keyring-user: {}
`,
    );
    process.env.GITHUB_TOKEN = "gho_generic_fallback";

    const accounts = await listAccounts();
    const byLogin = new Map(accounts.map((a) => [a.login, a.token]));
    expect(byLogin.get("techwithnidhi")).toBe("gho_aaa");
    expect(byLogin.get("keyring-user")).toBe("gho_generic_fallback");
  });

  it("a keyring-backed login with no plaintext token and no gh on PATH is omitted, not thrown", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "hosts.yml"),
      `github.com:
    users:
        keyring-user: {}
`,
    );

    await expect(listAccounts()).resolves.toEqual([]);
  });
});
