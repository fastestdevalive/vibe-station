/**
 * GitHub PR lookup (`daemon/src/services/github.ts`) — the VCS tool tab's PR
 * banner data source. Deliberately doesn't shell out to `gh`; talks to the
 * GitHub REST API directly, so `fetchPrForBranch` is tested via a stubbed
 * `global.fetch` rather than a real network call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getRemoteUrl,
  parseGithubRepo,
  fetchPrForBranch,
  _clearPrCacheForTest,
} from "../services/github.js";
import { createGitFixture, removeGitFixture, type GitFixture } from "./gitFixture.js";

describe("parseGithubRepo", () => {
  it("Requirement 5 — accepts git@github.com:owner/repo.git", () => {
    expect(parseGithubRepo("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("Requirement 5 — accepts https://github.com/owner/repo.git", () => {
    expect(parseGithubRepo("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("Requirement 5 — accepts https://github.com/owner/repo (no .git suffix)", () => {
    expect(parseGithubRepo("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("Requirement 5 — rejects a non-GitHub remote", () => {
    expect(parseGithubRepo("git@gitlab.com:owner/repo.git")).toBeNull();
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

/** Builds a fetch-mock response shaped like `GET /repos/:owner/:repo/pulls`. */
function mockPrListResponse(prs: unknown[]): typeof fetch {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => prs }) as unknown as typeof fetch;
}

function fakePr(overrides: Partial<{
  number: number;
  html_url: string;
  title: string;
  state: string;
  draft: boolean;
  merged_at: string | null;
  user: { login: string } | null;
}> = {}) {
  return {
    number: 1,
    html_url: "https://github.com/x/y/pull/1",
    title: "A PR",
    state: "open",
    draft: false,
    merged_at: null,
    user: { login: "someone" },
    ...overrides,
  };
}

describe("fetchPrForBranch", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    _clearPrCacheForTest();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    _clearPrCacheForTest();
  });

  it("Requirement 7 — a non-OK API response resolves to null without throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
    await expect(fetchPrForBranch("owner-403", "repo-403", "some-branch")).resolves.toBeNull();
  });

  it("Requirement 7 — a network failure resolves to null without throwing", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    await expect(fetchPrForBranch("owner-neterr", "repo-neterr", "some-branch")).resolves.toBeNull();
  });

  it("Requirement 7 — an empty PR list resolves to null", async () => {
    global.fetch = mockPrListResponse([]);
    await expect(fetchPrForBranch("owner-empty", "repo-empty", "some-branch")).resolves.toBeNull();
  });

  it("Requirement 8 — a matching PR is parsed into PrInfo, and the request is built correctly (URL, head filter, headers)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        fakePr({
          number: 42,
          html_url: "https://github.com/owner-match/repo-match/pull/42",
          title: "Add VCS commit graph",
          user: { login: "octocat" },
        }),
      ],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const pr = await fetchPrForBranch("owner-match", "repo-match", "some-branch");
    expect(pr).toEqual({
      number: 42,
      url: "https://github.com/owner-match/repo-match/pull/42",
      title: "Add VCS commit graph",
      state: "open",
      merged: false,
      draft: false,
      author: "octocat",
    });

    // Guards the request-construction contract, not just the response
    // parsing: wrong owner/repo in the URL path, or a missing/wrong
    // `head=owner:branch` filter, would misattribute PRs from the wrong
    // repo/branch to this worktree while every other assertion still passes.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/repos/owner-match/repo-match/pulls");
    expect(url).toContain("head=owner-match:some-branch");
    expect(url).toContain("state=all");
    expect((init as { headers: Record<string, string> }).headers.Accept).toBe(
      "application/vnd.github+json",
    );
  });

  it("Requirement 8 — a merged PR sets merged: true and state: closed", async () => {
    global.fetch = mockPrListResponse([
      fakePr({
        number: 7,
        html_url: "https://github.com/owner-merged/repo-merged/pull/7",
        title: "Merged feature",
        state: "closed",
        merged_at: "2026-01-01T00:00:00Z",
        user: { login: "hubot" },
      }),
    ]);

    const pr = await fetchPrForBranch("owner-merged", "repo-merged", "some-branch");
    expect(pr).toMatchObject({ number: 7, merged: true, state: "closed" });
  });

  it("caches a result for repeat calls with the same owner/repo/branch — fetch is called once", async () => {
    const fetchMock = mockPrListResponse([fakePr({ number: 99 })]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = await fetchPrForBranch("owner-cache", "repo-cache", "branch-cache");
    const second = await fetchPrForBranch("owner-cache", "repo-cache", "branch-cache");

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a different branch (different cache key) triggers a fresh fetch", async () => {
    const fetchMock = mockPrListResponse([fakePr({ number: 100 })]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchPrForBranch("owner-cachekey", "repo-cachekey", "branch-a");
    await fetchPrForBranch("owner-cachekey", "repo-cachekey", "branch-b");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("_clearPrCacheForTest() forces a fresh fetch even for a previously-cached key", async () => {
    const fetchMock = mockPrListResponse([fakePr({ number: 101 })]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchPrForBranch("owner-clear", "repo-clear", "branch-clear");
    _clearPrCacheForTest();
    await fetchPrForBranch("owner-clear", "repo-clear", "branch-clear");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
