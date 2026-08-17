/**
 * GitHub PR lookup (`daemon/src/services/github.ts`) — the VCS tool tab's PR
 * banner data source, and the PR poller's transport. Deliberately doesn't
 * shell out to `gh`; talks to the GitHub GraphQL API directly, so
 * `fetchPrForBranch`/`fetchPrsForBranches` are tested via a stubbed
 * `global.fetch` rather than a real network call. `listAccounts` (from
 * `./githubAuth.js`) is mocked so these tests never touch the real
 * filesystem (`~/.config/gh/hosts.yml`) or environment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getRemoteUrl,
  resolveGithubRemote,
  fetchPrForBranch,
  fetchPrsForBranches,
  _clearPrCacheForTest,
} from "../services/github.js";
import { createGitFixture, removeGitFixture, type GitFixture } from "./gitFixture.js";

vi.mock("../services/githubAuth.js", () => ({
  listAccounts: vi.fn(),
}));

import { listAccounts } from "../services/githubAuth.js";

const mockedListAccounts = vi.mocked(listAccounts);

describe("resolveGithubRemote", () => {
  // Hermetic (N4): point HOME at an empty temp dir with no `.ssh/config` at
  // all, so these tests never depend on — or are broken by — whatever real
  // SSH config happens to exist on the machine running them.
  let fakeHome: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "vst-github-nohome-test-"));
    process.env.HOME = fakeHome;
    _clearPrCacheForTest();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    _clearPrCacheForTest();
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("R1 — resolves an SSH host alias via the /^github[-.]/i heuristic (no ~/.ssh/config match)", async () => {
    await expect(resolveGithubRemote("git@github-x:o/r.git")).resolves.toEqual({
      host: "github-x",
      owner: "o",
      repo: "r",
    });
  });

  it("rejects a non-GitHub remote (no heuristic or ssh-config match)", async () => {
    await expect(resolveGithubRemote("git@gitlab.com:o/r.git")).resolves.toBeNull();
  });

  it("strips a trailing .git suffix", async () => {
    await expect(resolveGithubRemote("git@github.com:owner/repo.git")).resolves.toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  it("handles https:// remotes", async () => {
    await expect(resolveGithubRemote("https://github.com/owner/repo.git")).resolves.toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  it("handles ssh:// remotes", async () => {
    await expect(resolveGithubRemote("ssh://git@github.com/owner/repo.git")).resolves.toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  it("N3 — strips userinfo (user:token@) from an https:// remote's host", async () => {
    await expect(resolveGithubRemote("https://user:token@github.com/owner/repo.git")).resolves.toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  it("N3 — strips a :port suffix from an ssh:// remote's host", async () => {
    await expect(resolveGithubRemote("ssh://git@github.com:22/owner/repo.git")).resolves.toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });
});

describe("~/.ssh/config parsing (hermetic, N4)", () => {
  // Every test gets its own fake HOME with a purpose-built `.ssh/config` —
  // never the real file on the machine running the suite.
  let fakeHome: string;
  let sshDir: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "vst-github-sshconfig-test-"));
    sshDir = join(fakeHome, ".ssh");
    await mkdir(sshDir, { recursive: true });
    process.env.HOME = fakeHome;
    _clearPrCacheForTest();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    _clearPrCacheForTest();
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("resolves an alias to a GitHub host via HostName, lowercase keywords", async () => {
    await writeFile(
      join(sshDir, "config"),
      `host work-alias
    hostname github.com
    user git
`,
    );
    await expect(resolveGithubRemote("git@work-alias:acme/widgets.git")).resolves.toEqual({
      host: "work-alias",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("resolves via HostName with mixed-case keywords (Host/HostName)", async () => {
    await writeFile(
      join(sshDir, "config"),
      `Host personal-alias
    HostName github.com
    User git
`,
    );
    await expect(resolveGithubRemote("git@personal-alias:acme/widgets.git")).resolves.toEqual({
      host: "personal-alias",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("a Host line with multiple space-separated patterns applies HostName to every one", async () => {
    await writeFile(
      join(sshDir, "config"),
      `Host alias-one alias-two
    HostName github.com
`,
    );
    await expect(resolveGithubRemote("git@alias-one:acme/widgets.git")).resolves.toEqual({
      host: "alias-one",
      owner: "acme",
      repo: "widgets",
    });
    await expect(resolveGithubRemote("git@alias-two:acme/widgets.git")).resolves.toEqual({
      host: "alias-two",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("a HostName pointing somewhere other than github.com is rejected (no heuristic match)", async () => {
    await writeFile(
      join(sshDir, "config"),
      `Host internal-alias
    HostName git.internal.example.com
`,
    );
    await expect(resolveGithubRemote("git@internal-alias:acme/widgets.git")).resolves.toBeNull();
  });

  it("resolves an alias via a single level of Include", async () => {
    await writeFile(join(sshDir, "config"), `Include config.d/work\n`);
    await mkdir(join(sshDir, "config.d"), { recursive: true });
    await writeFile(
      join(sshDir, "config.d", "work"),
      `Host included-alias
    HostName github.com
`,
    );
    await expect(resolveGithubRemote("git@included-alias:acme/widgets.git")).resolves.toEqual({
      host: "included-alias",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("N4 — an edit to an Include'd file invalidates the cache, not just the top-level file", async () => {
    await writeFile(join(sshDir, "config"), `Include config.d/work\n`);
    await mkdir(join(sshDir, "config.d"), { recursive: true });
    const includedPath = join(sshDir, "config.d", "work");
    await writeFile(
      includedPath,
      `Host included-alias
    HostName git.internal.example.com
`,
    );

    // First resolution: the alias resolves to a non-GitHub host via the
    // Include'd file, so it's rejected.
    await expect(resolveGithubRemote("git@included-alias:acme/widgets.git")).resolves.toBeNull();

    // Edit ONLY the Include'd file (top-level `config`'s own mtime is
    // untouched) so it now points at github.com, and bump its mtime forward
    // to guarantee the filesystem records a change even on fast filesystems
    // with coarse mtime resolution.
    const future = new Date(Date.now() + 5000);
    await writeFile(
      includedPath,
      `Host included-alias
    HostName github.com
`,
    );
    await utimes(includedPath, future, future);

    await expect(resolveGithubRemote("git@included-alias:acme/widgets.git")).resolves.toEqual({
      host: "included-alias",
      owner: "acme",
      repo: "widgets",
    });
  });
});

describe("getRemoteUrl", () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createGitFixture("vst-github-remote-test");
  });

  afterEach(async () => {
    await removeGitFixture(fixture);
  });

  it("Requirement 6 — a repo with no origin remote resolves to null without throwing", async () => {
    await expect(getRemoteUrl(fixture.dir)).resolves.toBeNull();
  });

  it("returns the origin URL when one is configured", async () => {
    fixture.git(["remote", "add", "origin", "git@github.com:owner/repo.git"]);
    await expect(getRemoteUrl(fixture.dir)).resolves.toBe("git@github.com:owner/repo.git");
  });
});

/** Builds a GraphQL-shaped fetch-mock response for a single-repo query
 *  aliased as `repo0`. */
function mockGraphQLResponse(nodes: unknown[]): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    headers: new Headers(),
    json: async () => ({ data: { repo0: { pullRequests: { nodes } } } }),
  }) as unknown as typeof fetch;
}

function fakeNode(
  overrides: Partial<{
    number: number;
    url: string;
    title: string;
    state: string;
    isDraft: boolean;
    merged: boolean;
    author: { login: string } | null;
  }> = {},
) {
  return {
    number: 1,
    url: "https://github.com/x/y/pull/1",
    title: "A PR",
    state: "OPEN",
    isDraft: false,
    merged: false,
    author: { login: "someone" },
    ...overrides,
  };
}

describe("fetchPrForBranch / fetchPrsForBranches", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    _clearPrCacheForTest();
    mockedListAccounts.mockReset();
    mockedListAccounts.mockResolvedValue([{ login: "owner-match", token: "tok" }]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    _clearPrCacheForTest();
  });

  it("Requirement 7 — a non-OK API response resolves to {kind:\"error\"} without throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
    }) as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "owner-403", token: "tok" }]);
    await expect(fetchPrForBranch("owner-403", "repo-403", "some-branch")).resolves.toMatchObject(
      { kind: "error" },
    );
  });

  it("Requirement 7 — a network failure resolves to {kind:\"error\",reason:\"network\"} without throwing", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "owner-neterr", token: "tok" }]);
    await expect(
      fetchPrForBranch("owner-neterr", "repo-neterr", "some-branch"),
    ).resolves.toMatchObject({ kind: "error", reason: "network" });
  });

  it("Requirement 7 — an empty PR list resolves to {kind:\"no_pr\"}", async () => {
    global.fetch = mockGraphQLResponse([]);
    mockedListAccounts.mockResolvedValue([{ login: "owner-empty", token: "tok" }]);
    await expect(fetchPrForBranch("owner-empty", "repo-empty", "some-branch")).resolves.toEqual({
      kind: "no_pr",
    });
  });

  it("no accounts configured resolves to {kind:\"no_credentials\"} without a network call", async () => {
    mockedListAccounts.mockResolvedValue([]);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(fetchPrForBranch("owner-nocred", "repo-nocred", "b")).resolves.toEqual({
      kind: "no_credentials",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Requirement 8 — a matching PR is parsed into PrInfo, and the request is built correctly (query, headers)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({
        data: {
          repo0: {
            pullRequests: {
              nodes: [
                fakeNode({
                  number: 42,
                  url: "https://github.com/owner-match/repo-match/pull/42",
                  title: "Add VCS commit graph",
                  author: { login: "octocat" },
                }),
              ],
            },
          },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchPrForBranch("owner-match", "repo-match", "some-branch");
    expect(result).toEqual({
      kind: "pr",
      pr: {
        number: 42,
        url: "https://github.com/owner-match/repo-match/pull/42",
        title: "Add VCS commit graph",
        state: "open",
        merged: false,
        draft: false,
        author: "octocat",
      },
    });

    // Guards the request-construction contract, not just the response
    // parsing: a missing/wrong owner/repo/branch in the aliased query would
    // misattribute PRs from the wrong repo/branch to this worktree while
    // every other assertion still passes.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/graphql");
    const body = JSON.parse((init as { body: string }).body) as { query: string };
    expect(body.query).toContain('owner: "owner-match"');
    expect(body.query).toContain('name: "repo-match"');
    expect(body.query).toContain('headRefName: "some-branch"');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer tok");
  });

  it("Requirement 8 — a merged PR sets merged: true and state: closed", async () => {
    global.fetch = mockGraphQLResponse([
      fakeNode({
        number: 7,
        url: "https://github.com/owner-merged/repo-merged/pull/7",
        title: "Merged feature",
        state: "MERGED",
        merged: true,
        author: { login: "hubot" },
      }),
    ]);
    mockedListAccounts.mockResolvedValue([{ login: "owner-merged", token: "tok" }]);

    const result = await fetchPrForBranch("owner-merged", "repo-merged", "some-branch");
    expect(result).toMatchObject({ kind: "pr", pr: { number: 7, merged: true, state: "closed" } });
  });

  it("caches a result for repeat calls with the same owner/repo/branch — fetch is called once", async () => {
    const fetchMock = mockGraphQLResponse([fakeNode({ number: 99 })]);
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "owner-cache", token: "tok" }]);

    const first = await fetchPrForBranch("owner-cache", "repo-cache", "branch-cache");
    const second = await fetchPrForBranch("owner-cache", "repo-cache", "branch-cache");

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a different branch (different cache key) triggers a fresh fetch", async () => {
    const fetchMock = mockGraphQLResponse([fakeNode({ number: 100 })]);
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "owner-cachekey", token: "tok" }]);

    await fetchPrForBranch("owner-cachekey", "repo-cachekey", "branch-a");
    await fetchPrForBranch("owner-cachekey", "repo-cachekey", "branch-b");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("_clearPrCacheForTest() forces a fresh fetch even for a previously-cached key", async () => {
    const fetchMock = mockGraphQLResponse([fakeNode({ number: 101 })]);
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "owner-clear", token: "tok" }]);

    await fetchPrForBranch("owner-clear", "repo-clear", "branch-clear");
    _clearPrCacheForTest();
    mockedListAccounts.mockResolvedValue([{ login: "owner-clear", token: "tok" }]);
    await fetchPrForBranch("owner-clear", "repo-clear", "branch-clear");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an error result is never cached — the next call re-fetches", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers() })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({ data: { repo0: { pullRequests: { nodes: [] } } } }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "owner-noerrcache", token: "tok" }]);

    const first = await fetchPrForBranch("owner-noerrcache", "repo-noerrcache", "b");
    expect(first).toMatchObject({ kind: "error" });
    const second = await fetchPrForBranch("owner-noerrcache", "repo-noerrcache", "b");
    expect(second).toEqual({ kind: "no_pr" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Requirement 4/T3 — one NOT_FOUND alias in a multi-repo query still returns sibling results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({
        data: {
          repo0: null,
          repo1: { pullRequests: { nodes: [fakeNode({ number: 5 })] } },
        },
        errors: [{ path: ["repo0"], type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "acct", token: "tok" }]);

    const results = await fetchPrsForBranches([
      { owner: "acct", repo: "missing", branch: "b" },
      { owner: "acct", repo: "present", branch: "b" },
    ]);

    expect(results.get("acct/missing#b")).toEqual({ kind: "no_pr" });
    expect(results.get("acct/present#b")).toMatchObject({ kind: "pr", pr: { number: 5 } });
    // One aliased query per account, not one per repo (D1/K4).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Requirement T4 — a 403 with rate-limit headers maps to reason: rate_limited with retryAfterMs", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ "x-ratelimit-remaining": "0", "retry-after": "30" }),
    }) as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "owner-ratelimit", token: "tok" }]);

    await expect(
      fetchPrForBranch("owner-ratelimit", "repo-ratelimit", "b"),
    ).resolves.toEqual({
      kind: "error",
      reason: "rate_limited",
      message: expect.any(String),
      retryAfterMs: 30_000,
    });
  });

  it("B1 — a 200 response with errors[] and NO data is a definitive {kind:\"error\"}, never no_pr", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        // No `data` key at all — this is the exact GraphQL shape GitHub uses
        // for rate-limiting, INTERNAL errors, and SAML-enforced FORBIDDEN.
      }),
    });
    mockedListAccounts.mockResolvedValue([{ login: "owner-nodata", token: "tok" }]);

    const result = await fetchPrForBranch("owner-nodata", "repo-nodata", "b");
    expect(result).toMatchObject({ kind: "error", reason: "rate_limited" });
  });

  it("B1 — a null alias with NO matching NOT_FOUND error surfaces as {kind:\"error\"}, never no_pr (siblings unaffected)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({
        data: {
          // repo0 is null but there's no corresponding NOT_FOUND error for
          // it — e.g. a partial-failure response where a sibling repo was
          // INTERNAL/RATE_LIMITED. Laundering this into `no_pr` would wipe
          // real PR state (B1).
          repo0: null,
          repo1: { pullRequests: { nodes: [fakeNode({ number: 9 })] } },
        },
        errors: [{ path: ["repo0"], type: "INTERNAL", message: "Something went wrong" }],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "acct-partial", token: "tok" }]);

    const results = await fetchPrsForBranches([
      { owner: "acct-partial", repo: "broken", branch: "b" },
      { owner: "acct-partial", repo: "ok", branch: "b" },
    ]);

    expect(results.get("acct-partial/broken#b")).toMatchObject({ kind: "error" });
    expect(results.get("acct-partial/ok#b")).toMatchObject({ kind: "pr", pr: { number: 9 } });
  });

  it("N2 — a rate-limited 403 gates further requests for that account until retryAfterMs elapses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ "x-ratelimit-remaining": "0", "retry-after": "60" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "owner-gated", token: "tok" }]);

    const first = await fetchPrsForBranches([{ owner: "owner-gated", repo: "r", branch: "b" }]);
    expect(first.get("owner-gated/r#b")).toMatchObject({ kind: "error", reason: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call, same account, still within the retry window: must not
    // hit the network again — the gate short-circuits it.
    const second = await fetchPrsForBranches([{ owner: "owner-gated", repo: "r2", branch: "b" }]);
    expect(second.get("owner-gated/r2#b")).toMatchObject({ kind: "error", reason: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("N1 — two owners resolved to the same cached account are merged into ONE query, not one per owner", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({
        data: {
          repo0: { pullRequests: { nodes: [fakeNode({ number: 1 })] } },
          repo1: { pullRequests: { nodes: [fakeNode({ number: 2 })] } },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedListAccounts.mockResolvedValue([{ login: "shared-acct", token: "tok" }]);

    // First tick: both owners are new, each probes independently — 2 calls,
    // but both resolve to the same account and get cached as such.
    await fetchPrsForBranches([
      { owner: "owner-a", repo: "repo-a", branch: "b" },
      { owner: "owner-b", repo: "repo-b", branch: "b" },
    ]);
    fetchMock.mockClear();

    // Second tick: both owners are now cached to `shared-acct` — must merge
    // into a single request instead of one per owner (N1).
    const results = await fetchPrsForBranches([
      { owner: "owner-a", repo: "repo-a", branch: "b" },
      { owner: "owner-b", repo: "repo-b", branch: "b" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.get("owner-a/repo-a#b")).toMatchObject({ kind: "pr", pr: { number: 1 } });
    expect(results.get("owner-b/repo-b#b")).toMatchObject({ kind: "pr", pr: { number: 2 } });
  });
});
