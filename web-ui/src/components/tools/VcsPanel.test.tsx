import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { VcsPanel, prStatusMessage } from "./VcsPanel";
import { useWorkspaceStore } from "@/hooks/useStore";
import { resetVcsCacheForTests } from "@/components/vcs/vcsCacheStore";
import { resetVcsRevalidationForTests } from "@/components/vcs/useVcsCommits";
import { copyText } from "@/lib/copyText";
import type { CommitLogEntry, PrErrorKind, PrInfo, PrStatus, SubmoduleInfo } from "@/api/types";

vi.mock("@/lib/copyText", () => ({ copyText: vi.fn(async () => true) }));

/** Builds `count` synthetic commits, newest first, all on-branch unless overridden. */
function makeCommits(count: number, opts: { isOnBranch?: (i: number) => boolean } = {}): CommitLogEntry[] {
  const isOnBranch = opts.isOnBranch ?? (() => true);
  return Array.from({ length: count }, (_, i) => ({
    // Padded with "x" (never "0") so e.g. index 1 and 10 can't collapse into
    // the same padded string the way zero-padding after a numeric suffix can.
    sha: `sha-${i}-`.padEnd(40, "x"),
    shortSha: `sha-${i}`.slice(0, 7),
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.com",
    date: new Date(2026, 0, 1, 12, 0, 0, -i * 1000).toISOString(),
    subject: `commit #${i}`,
    body: `commit #${i}`,
    insertions: 1,
    deletions: 0,
    hasBinaryChanges: false,
    isOnBranch: isOnBranch(i),
  }));
}

/**
 * A `listCommits` stub backed by a per-worktree commit pool, honoring the
 * `limit` argument the way the real API does (`.slice(0, limit)`) rather than
 * returning the whole pool regardless of what was asked for — this is what
 * makes assertions like "80 total < 101 requested, so there's no more" (the
 * `limit + 1` lookahead contract `VcsPanel` relies on) actually meaningful.
 */
function limitAwareListCommits(pools: Record<string, CommitLogEntry[]>) {
  return vi.fn(async (worktreeId: string, limit = 200) => (pools[worktreeId] ?? []).slice(0, limit));
}

/** A promise plus its resolve/reject, for tests that need to control fetch timing. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function prStatusFixture(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    state: "none",
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("prStatusMessage", () => {
  it("renders a distinct row per PR poll state", () => {
    const cases: Array<[PrErrorKind | undefined, string]> = [
      ["no_credentials", "No GitHub credentials — run gh auth login"],
      ["auth", "GitHub token can't access this repo"],
      ["not_found", "Repo not visible to configured accounts"],
      ["transient", "PR lookup failed, retrying…"],
      ["unsupported", "Unsupported GitHub host — PR status unavailable"],
    ];
    for (const [kind, text] of cases) {
      expect(prStatusMessage(prStatusFixture({ errorKind: kind }))?.text).toBe(text);
    }
  });

  it("has no row for a healthy status", () => {
    expect(prStatusMessage(prStatusFixture())).toBeNull();
    expect(prStatusMessage(null)).toBeNull();
  });

  it("flags a held last-known value as stale, with the last check in the tooltip", () => {
    const message = prStatusMessage(
      prStatusFixture({
        state: "open",
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        staleSince: "2026-01-02T00:00:00.000Z",
      }),
    );
    expect(message?.text).toContain("stale");
    expect(message?.title).toContain("2026-01-01T00:00:00.000Z");
  });

  it("shows the stale marker even when a failure kind is also held", () => {
    const message = prStatusMessage(
      prStatusFixture({ errorKind: "not_found", staleSince: "2026-01-02T00:00:00.000Z" }),
    );
    expect(message?.text).toContain("stale");
  });
});

describe("prStatusMessage", () => {
  it("renders a distinct row per PR poll state", () => {
    const cases: Array<[PrErrorKind | undefined, string]> = [
      ["no_credentials", "No GitHub credentials — run gh auth login"],
      ["auth", "GitHub token can't access this repo"],
      ["not_found", "Repo not visible to configured accounts"],
      ["transient", "PR lookup failed, retrying…"],
      ["unsupported", "Unsupported GitHub host — PR status unavailable"],
    ];
    for (const [kind, text] of cases) {
      expect(prStatusMessage(prStatusFixture({ errorKind: kind }))?.text).toBe(text);
    }
  });

  it("has no row for a healthy status", () => {
    expect(prStatusMessage(prStatusFixture())).toBeNull();
    expect(prStatusMessage(null)).toBeNull();
  });

  it("flags a held last-known value as stale, with the last check in the tooltip", () => {
    const message = prStatusMessage(
      prStatusFixture({
        state: "open",
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        staleSince: "2026-01-02T00:00:00.000Z",
      }),
    );
    expect(message?.text).toContain("stale");
    expect(message?.title).toContain("2026-01-01T00:00:00.000Z");
  });

  it("shows the stale marker even when a failure kind is also held", () => {
    const message = prStatusMessage(
      prStatusFixture({ errorKind: "not_found", staleSince: "2026-01-02T00:00:00.000Z" }),
    );
    expect(message?.text).toContain("stale");
  });
});

/** Rows currently rendered in the commit list (not the submodules section). */
const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".vcs-list > li.vcs-row"));

/** The api spies this file needs; `listCommits` answers from a per-worktree pool, honouring `limit`. */
function apiFor(pools: Record<string, CommitLogEntry[]>, extra: { submodules?: SubmoduleInfo[]; pr?: PrInfo | null } = {}) {
  const api = createMockApi();
  const listCommits = vi
    .spyOn(api, "listCommits")
    .mockImplementation(limitAwareListCommits(pools) as unknown as ApiInstance["listCommits"]);
  const getPr = vi.spyOn(api, "getPr").mockResolvedValue(extra.pr ?? null);
  const listSubmodules = vi.spyOn(api, "listSubmodules").mockResolvedValue(extra.submodules ?? []);
  const listChangedPaths = vi.spyOn(api, "listChangedPaths").mockResolvedValue([]);
  const getDiff = vi.spyOn(api, "getDiff").mockResolvedValue("diff --git a/src/App.tsx b/src/App.tsx\n");
  return { api, listCommits, getPr, listSubmodules, listChangedPaths, getDiff };
}

/** Selects a commit in the store, as a row click does (the docked sidebar opens on it). */
function selectCommit(worktreeId: string, sha: string, submodule?: string) {
  useWorkspaceStore.getState().setVcsSelectedCommit(worktreeId, sha, submodule);
}

beforeEach(() => {
  resetVcsCacheForTests();
  resetVcsRevalidationForTests();
  useWorkspaceStore.setState({ vcsSelectedCommitByWorktree: {}, vcsSidebarVisibleByWorktree: {} });
});

describe("VcsPanel — full-pane commit list", () => {
  it("Requirement 1 — fewer than a page of commits: no Load button, header count matches, no Refresh button in the header", async () => {
    const { api } = apiFor({ "wt-1": makeCommits(12) });
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(12));
    expect(screen.getByText("Commits").parentElement?.querySelector(".rail-header__count")).toHaveTextContent("12");
    expect(screen.queryByRole("button", { name: /Load 50 more/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh commits" })).toBeNull();
  });

  it("no commit selected: the list fills the pane and no docked sidebar is mounted", async () => {
    const { api } = apiFor({ "wt-1": makeCommits(3) });
    const { container } = render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(container.querySelector(".vcs-sidebar")).toBeNull();
    expect(container.querySelector(".vcs-list-pane > .rail-header")).not.toBeNull();
  });

  it("Requirement 2 — more than a page of commits: exactly 50 rows and a Load 50 more button", async () => {
    const { api } = apiFor({ "wt-1": makeCommits(120, { isOnBranch: () => true }) });
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(50));
    expect(screen.getByRole("button", { name: "Load 50 more" })).toBeInTheDocument();
  });

  it("Requirement 3 — Load 50 more fetches the next page (limit + 1 lookahead) and appends it", async () => {
    const { api, listCommits } = apiFor({ "wt-1": makeCommits(120, { isOnBranch: () => true }) });
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(50));
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    await waitFor(() => expect(rows()).toHaveLength(100));
    expect(listCommits).toHaveBeenLastCalledWith("wt-1", 101, "worktree", undefined);
  });

  it("Requirement 4 — a failed Load more keeps the rows on screen and shows the refresh bar with Retry, not a full-pane error", async () => {
    const { api, listCommits } = apiFor({ "wt-1": makeCommits(120, { isOnBranch: () => true }) });
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(50));
    listCommits.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    await screen.findByText(/Couldn’t refresh/);
    expect(rows()).toHaveLength(50);
    expect(screen.queryByText(/Failed to load commits/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("Requirement 4b — Retry after a failed refresh clears the bar and refetches", async () => {
    const { api, listCommits } = apiFor({ "wt-1": makeCommits(12) });
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(12));
    listCommits.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh now" }));
    await screen.findByText(/Couldn’t refresh/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/Couldn’t refresh/)).toBeNull());
    expect(rows()).toHaveLength(12);
  });

  it("Requirement 1a-1e — 'since main' is the default: only the branch's own commits; 'all history' shows the upstream with a 'from main' divider", async () => {
    const { api } = apiFor({ "wt-1": makeCommits(10, { isOnBranch: (i) => i < 4 }) });
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(screen.getByRole("button", { name: "Commit range" })).toHaveTextContent("since main");
    expect(document.querySelector(".vcs-list__divider")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Commit range" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "all history" }));
    await waitFor(() => expect(rows()).toHaveLength(10));
    expect(document.querySelector(".vcs-list__divider")).toHaveTextContent("from main");
  });

  it("Requirement 1g — the dropdown falls back to 'main' when baseBranch is unset", async () => {
    const { api } = apiFor({ "wt-1": makeCommits(3) });
    render(<VcsPanel api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.getByRole("button", { name: "Commit range" })).toHaveTextContent("since main");
  });

  it("Requirement 6 — switching worktreeId resets pagination back to one page, even after Load more advanced it", async () => {
    const { api, listCommits } = apiFor({
      "wt-1": makeCommits(120, { isOnBranch: () => true }),
      "wt-2": makeCommits(120, { isOnBranch: () => true }),
    });
    const { rerender } = render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(50));
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    await waitFor(() => expect(rows()).toHaveLength(100));
    rerender(<VcsPanel api={api} worktreeId="wt-2" baseBranch="main" />);
    await waitFor(() => expect(listCommits).toHaveBeenLastCalledWith("wt-2", 51, "worktree", undefined));
    await waitFor(() => expect(rows()).toHaveLength(50));
  });

  it("Requirement 1f — Load more turns 'since main' OFF when the new page adds no branch commits", async () => {
    // 50 own commits, then 10 upstream: the first page is all own, so "Load more" adds only upstream.
    const pool = makeCommits(60, { isOnBranch: (i) => i < 50 });
    const { api } = apiFor({ "wt-1": pool });
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(50));
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    await waitFor(() => expect(rows()).toHaveLength(60));
    expect(screen.getByRole("button", { name: "Commit range" })).toHaveTextContent("all history");
  });

  it("Requirement 1f (negative) — Load more that adds own commits leaves 'since main' ON", async () => {
    const pool = makeCommits(120, { isOnBranch: (i) => i < 70 });
    const { api } = apiFor({ "wt-1": pool });
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(50));
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    await waitFor(() => expect(rows()).toHaveLength(70));
    expect(screen.getByRole("button", { name: "Commit range" })).toHaveTextContent("since main");
  });

  it("a stale in-flight Load more for the previous worktree never overwrites the new worktree's rows", async () => {
    const pool2 = makeCommits(3).map((c) => ({ ...c, subject: `wt2 ${c.subject}`, sha: `${c.sha}b` }));
    const { api, listCommits } = apiFor({ "wt-1": makeCommits(120, { isOnBranch: () => true }), "wt-2": pool2 });
    const { rerender } = render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(50));
    const slow = deferred<CommitLogEntry[]>();
    listCommits.mockImplementationOnce(() => slow.promise);
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    rerender(<VcsPanel api={api} worktreeId="wt-2" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await act(async () => {
      slow.resolve(makeCommits(101, { isOnBranch: () => true }));
      await slow.promise;
    });
    expect(rows()).toHaveLength(3);
    expect(screen.getByTitle("wt2 commit #0")).toBeInTheDocument();
  });

  it("a failed Load more with 'since main' on does not leave an armed check that flips it OFF on a later refresh", async () => {
    const pool = makeCommits(120, { isOnBranch: (i) => i < 70 });
    const { api, listCommits } = apiFor({ "wt-1": pool });
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(50));
    listCommits.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    await screen.findByText(/Couldn’t refresh/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/Couldn’t refresh/)).toBeNull());
    expect(screen.getByRole("button", { name: "Commit range" })).toHaveTextContent("since main");
  });

  it("cold open: skeleton rows in the row shape, no count and no 'Loading commits…' text", async () => {
    const pending = deferred<CommitLogEntry[]>();
    const api = createMockApi();
    vi.spyOn(api, "listCommits").mockReturnValue(pending.promise);
    vi.spyOn(api, "getPr").mockResolvedValue(null);
    vi.spyOn(api, "listSubmodules").mockResolvedValue([]);
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    expect(document.querySelectorAll(".vcs-list--skeleton .vcs-row--skeleton")).toHaveLength(6);
    expect(screen.queryByText("Loading commits…")).toBeNull();
    expect(screen.getByText("Commits").parentElement?.querySelector(".rail-header__count")).toBeNull();
    await act(async () => {
      pending.resolve(makeCommits(2));
      await pending.promise;
    });
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it("warm reopen: the cached rows paint synchronously on remount, then the list revalidates", async () => {
    const { api, listCommits } = apiFor({ "wt-1": makeCommits(5) });
    const first = render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(5));
    first.unmount();
    listCommits.mockClear();
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    expect(rows()).toHaveLength(5);
    expect(document.querySelector(".vcs-list--skeleton")).toBeNull();
    await waitFor(() => expect(listCommits).toHaveBeenCalledTimes(1));
  });

  it("the PR slot renders the PR banner when getPr resolves, and the list never waits for it", async () => {
    const pendingPr = deferred<PrInfo | null>();
    const { api } = apiFor({ "wt-1": makeCommits(3) });
    vi.spyOn(api, "getPr").mockReturnValue(pendingPr.promise);
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(document.querySelector(".vcs-pr")).toBeNull();
    await act(async () => {
      pendingPr.resolve({ number: 7, title: "Tools pane", url: "https://example.com/pr/7", state: "open", draft: false, merged: false, author: "gb" } as PrInfo);
      await pendingPr.promise;
    });
    await waitFor(() => expect(document.querySelector(".vcs-pr")).toHaveTextContent("Tools pane"));
  });

  it("project scope: the commit list shows every commit (no since-main dropdown) and never asks for a PR", async () => {
    const { api, listCommits, getPr } = apiFor({ "proj-1": makeCommits(4, { isOnBranch: (i) => i < 1 }) });
    render(<VcsPanel api={api} worktreeId="proj-1" scope="project" />);
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(listCommits).toHaveBeenCalledWith("proj-1", 51, "project", undefined);
    expect(screen.queryByRole("button", { name: "Commit range" })).toBeNull();
    expect(getPr).not.toHaveBeenCalled();
  });

  it("submodules: a non-empty list renders a Submodules section, an empty one renders nothing", async () => {
    const sub: SubmoduleInfo = { path: "vendor/x", status: "clean", shortSha: "abc1234", subject: "init", sha: "abc1234" } as unknown as SubmoduleInfo;
    const withSub = apiFor({ "wt-1": makeCommits(2) }, { submodules: [sub] });
    const { unmount } = render(<VcsPanel api={withSub.api} worktreeId="wt-1" baseBranch="main" />);
    await screen.findByText("Submodules");
    unmount();
    const none = apiFor({ "wt-1": makeCommits(2) }, { submodules: [] });
    render(<VcsPanel api={none.api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByText("Submodules")).toBeNull();
  });

  it("submodule commit lists are lazy: nothing is fetched until a submodule row is expanded", async () => {
    const sub = { path: "vendor/x", status: "clean", shortSha: "abc1234", subject: "init", sha: "abc1234" } as unknown as SubmoduleInfo;
    const { api, listCommits } = apiFor({ "wt-1": makeCommits(2) }, { submodules: [sub] });
    const { container } = render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await screen.findByText("Submodules");
    expect(listCommits.mock.calls.some((c) => c[3] === "vendor/x")).toBe(false);
    fireEvent.click(container.querySelector<HTMLElement>(".vcs-submodules__toggle")!);
    await waitFor(() => expect(listCommits.mock.calls.some((c) => c[3] === "vendor/x")).toBe(true));
  });
});

describe("VcsPanel — docked two-level sidebar", () => {
  /** The docked sidebar's own DOM: the tab, the strip and the tree also show file names, so scope every lookup. */
  const sidebar = () => document.querySelector<HTMLElement>(".vcs-sidebar") ?? document.body;
  const SHA = "a".repeat(40);
  const SHA2 = "b".repeat(40);
  const commitsWithShas = (): CommitLogEntry[] => {
    const base = makeCommits(4, { isOnBranch: () => true });
    return base.map((c, i) => ({ ...c, sha: i === 0 ? SHA : i === 1 ? SHA2 : c.sha, subject: i === 0 ? "first commit" : c.subject }));
  };

  it("10.T1 — picking a commit docks the list as the sidebar; its changed files come from GET /changed-paths with scope=commit and the sha, and a file's diff uses that sha", async () => {
    const { api, listChangedPaths, getDiff } = apiFor({ "wt-1": commitsWithShas() });
    listChangedPaths.mockResolvedValue([{ path: "src/App.tsx", status: "M" }]);
    const user = userEvent.setup();
    const { container } = render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(rows()).toHaveLength(4));
    await user.click(screen.getByTitle("first commit"));
    await waitFor(() => expect(listChangedPaths).toHaveBeenCalledWith("wt-1", "commit", SHA, "worktree", undefined));
    expect(container.querySelector(".vcs-sidebar")).toBeInTheDocument();
    await waitFor(() => expect(within(sidebar()).getByText("App.tsx")).toBeInTheDocument());
    await user.click(within(sidebar()).getByText("App.tsx"));
    await waitFor(() => expect(getDiff).toHaveBeenCalledWith("wt-1", "src/App.tsx", "commit", SHA, "worktree", undefined));
  });

  it("the sidebar detail shows subject, author, the short sha and totals; the sha click copies the full sha", async () => {
    const { api } = apiFor({ "wt-1": commitsWithShas() });
    selectCommit("wt-1", SHA);
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(within(sidebar()).getByText("first commit")).toBeInTheDocument());
    expect(within(sidebar()).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "aaaaaaa" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "aaaaaaa" }));
    expect(vi.mocked(copyText)).toHaveBeenCalledWith(SHA);
  });

  it("'‹ Commits' goes up one level: the compact list stays docked, the open commit is marked, the diff stays", async () => {
    const { api } = apiFor({ "wt-1": commitsWithShas() });
    selectCommit("wt-1", SHA);
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(within(sidebar()).getByText("first commit")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Commits$/ }));
    await waitFor(() => expect(document.querySelector(".vcs-row--active")).toBeTruthy());
    expect(document.querySelector(".vcs-row--active button")).toHaveAttribute("aria-current", "true");
    expect(document.querySelector(".vcs-row--active")).toHaveTextContent("first commit");
    expect(useWorkspaceStore.getState().vcsSelectedCommitByWorktree["wt-1"]?.sha).toBe(SHA);
  });

  it("Esc in the files list goes up one level", async () => {
    const { api, listChangedPaths } = apiFor({ "wt-1": commitsWithShas() });
    listChangedPaths.mockResolvedValue([{ path: "src/App.tsx", status: "M" }]);
    selectCommit("wt-1", SHA);
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(within(sidebar()).getByText("App.tsx")).toBeInTheDocument());
    fireEvent.keyDown(within(sidebar()).getByText("App.tsx"), { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".vcs-row--active")).toBeTruthy());
  });

  it("older / newer step through the list order, disable at the ends, and ] / [ do the same", async () => {
    const { api } = apiFor({ "wt-1": commitsWithShas() });
    selectCommit("wt-1", SHA2);
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(within(sidebar()).getByText("commit #1")).toBeInTheDocument());
    const older = screen.getByRole("button", { name: "Older commit" });
    const newer = screen.getByRole("button", { name: "Newer commit" });
    expect(newer).not.toBeDisabled();
    expect(older).not.toBeDisabled();
    fireEvent.click(newer);
    await waitFor(() => expect(useWorkspaceStore.getState().vcsSelectedCommitByWorktree["wt-1"]?.sha).toBe(SHA));
    expect(screen.getByRole("button", { name: "Newer commit" })).toBeDisabled();
    fireEvent.keyDown(document.querySelector(".vcs-commit-detail")!, { key: "]" });
    await waitFor(() => expect(useWorkspaceStore.getState().vcsSelectedCommitByWorktree["wt-1"]?.sha).toBe(SHA2));
    fireEvent.keyDown(document.querySelector(".vcs-commit-detail")!, { key: "[" });
    await waitFor(() => expect(useWorkspaceStore.getState().vcsSelectedCommitByWorktree["wt-1"]?.sha).toBe(SHA));
  });

  it("a second visit to the same commit does not refetch its changed files (per-sha cache)", async () => {
    const { api, listChangedPaths } = apiFor({ "wt-1": commitsWithShas() });
    listChangedPaths.mockResolvedValue([{ path: "src/App.tsx", status: "M" }]);
    selectCommit("wt-1", SHA);
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(within(sidebar()).getByText("App.tsx")).toBeInTheDocument());
    selectCommit("wt-1", SHA2);
    await waitFor(() => expect(listChangedPaths).toHaveBeenCalledTimes(2));
    selectCommit("wt-1", SHA);
    await waitFor(() => expect(within(sidebar()).getByText("App.tsx")).toBeInTheDocument());
    expect(listChangedPaths).toHaveBeenCalledTimes(2);
  });

  it("toggling the sidebar (VCS rail icon) keeps the diff preview column mounted", async () => {
    const { api, listChangedPaths } = apiFor({ "wt-1": commitsWithShas() });
    listChangedPaths.mockResolvedValue([{ path: "src/App.tsx", status: "M" }]);
    selectCommit("wt-1", SHA);
    const { container } = render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(within(sidebar()).getByText("App.tsx")).toBeInTheDocument());
    const preview = container.querySelector(".preview-pane");
    useWorkspaceStore.setState({ vcsSidebarVisibleByWorktree: { "wt-1": false } });
    useWorkspaceStore.setState({ vcsSidebarVisibleByWorktree: { "wt-1": true } });
    expect(container.querySelector(".preview-pane")).toBe(preview);
  });

  it("the commit's files list shows inside the sidebar header 'Files N' count", async () => {
    const { api, listChangedPaths } = apiFor({ "wt-1": commitsWithShas() });
    listChangedPaths.mockResolvedValue([
      { path: "src/App.tsx", status: "M" },
      { path: "src/B.tsx", status: "A" },
    ]);
    selectCommit("wt-1", SHA);
    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await waitFor(() => expect(within(sidebar()).getByText("src/B.tsx".split("/").pop()!)).toBeInTheDocument());
    expect(within(document.querySelector(".vcs-commit-detail")!).getByText("Files 2")).toBeInTheDocument();
  });
});
