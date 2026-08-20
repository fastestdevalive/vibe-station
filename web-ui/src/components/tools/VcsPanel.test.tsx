import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { VcsPanel } from "./VcsPanel";
import type { CommitLogEntry, SubmoduleInfo } from "@/api/types";

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

describe("VcsPanel", () => {
  it("Requirement 1 — fewer than a page of commits: no Load more button, header count matches", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listCommits").mockImplementation(limitAwareListCommits({ "wt-1": makeCommits(5) }));
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" />);

    await screen.findByText("Commits (5)");
    expect(screen.queryByRole("button", { name: /load 50 more/i })).not.toBeInTheDocument();
  });

  it("Requirement 2 — more than a page of commits: shows exactly PAGE_SIZE (50) and a Load more button", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "listCommits").mockImplementation(limitAwareListCommits({ "wt-1": makeCommits(80) }));
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" />);

    await screen.findByText("Commits (50)");
    expect(screen.getByRole("button", { name: /load 50 more/i })).toBeInTheDocument();
    // The initial fetch requests one lookahead commit beyond the page size,
    // so "exactly 50 vs. more available" is known for certain rather than
    // guessed from the page being full.
    expect(spy).toHaveBeenCalledWith("wt-1", 51);
  });

  it("Requirement 3 — clicking Load more fetches the next page and appends it", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const spy = vi.spyOn(api, "listCommits").mockImplementation(limitAwareListCommits({ "wt-1": makeCommits(80) }));
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("Commits (50)");

    await user.click(screen.getByRole("button", { name: /load 50 more/i }));

    await screen.findByText("Commits (80)");
    expect(spy).toHaveBeenLastCalledWith("wt-1", 101);
    // The pool only has 80, so the 101-commit request genuinely returns
    // fewer than asked — the lookahead entry never came back, so there's no
    // more and the button is gone (not just "the mock ran out").
    expect(screen.queryByRole("button", { name: /load 50 more/i })).not.toBeInTheDocument();
  });

  it("Requirement 4 — a failed Load more keeps the already-loaded commits on screen and shows an inline error, not a full-panel error", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const spy = vi
      .spyOn(api, "listCommits")
      .mockImplementationOnce(limitAwareListCommits({ "wt-1": makeCommits(80) }))
      .mockRejectedValueOnce(new Error("network blip"));
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("Commits (50)");

    await user.click(screen.getByRole("button", { name: /load 50 more/i }));

    await screen.findByText(/failed to load more: network blip/i);
    // The 50 commits already on screen are untouched — this is not the
    // full-panel "Failed to load commits" error state.
    expect(screen.getByText("Commits (50)")).toBeInTheDocument();
    expect(screen.queryByText(/^failed to load commits/i)).not.toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("Requirement 4b — a Refresh after a failed Load more clears the stale load-more error", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.spyOn(api, "listCommits")
      .mockImplementationOnce(limitAwareListCommits({ "wt-1": makeCommits(80) }))
      .mockRejectedValueOnce(new Error("network blip"))
      .mockImplementation(limitAwareListCommits({ "wt-1": makeCommits(80) }));
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("Commits (50)");
    await user.click(screen.getByRole("button", { name: /load 50 more/i }));
    await screen.findByText(/failed to load more: network blip/i);

    await user.click(screen.getByRole("button", { name: /refresh commits/i }));
    await waitFor(() => expect(screen.queryByText(/failed to load more/i)).not.toBeInTheDocument());
    expect(screen.getByText("Commits (50)")).toBeInTheDocument();
  });

  it("Requirement 1a-1e — diff-from-main toggle: ON by default shows own commits only, header count follows, OFF shows the full unfiltered list", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    // 3 own commits (newest), then 4 upstream commits.
    vi.spyOn(api, "listCommits").mockImplementation(
      limitAwareListCommits({ "wt-1": makeCommits(7, { isOnBranch: (i) => i < 3 }) }),
    );
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await screen.findByText("Commits (3)");

    const toggle = screen.getByRole("checkbox", { name: /diff from main/i });
    expect(toggle).toBeChecked();
    expect(screen.getByText("commit #0")).toBeInTheDocument();
    expect(screen.getByText("commit #2")).toBeInTheDocument();
    expect(screen.queryByText("commit #3")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(screen.getByText("commit #3")).toBeInTheDocument());
    expect(screen.getByText("commit #6")).toBeInTheDocument();
    expect(screen.getByText("Commits (7)")).toBeInTheDocument();
  });

  it("Requirement 1g — toggle label falls back to 'Diff from main' when baseBranch is unset", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listCommits").mockImplementation(limitAwareListCommits({ "wt-1": makeCommits(5) }));
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("Commits (5)");

    expect(screen.getByRole("checkbox", { name: /diff from main/i })).toBeInTheDocument();
  });

  it("Requirement 6 — switching worktreeId resets pagination back to one page, even after Load more advanced it", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const spy = vi.spyOn(api, "listCommits").mockImplementation(
      limitAwareListCommits({ "wt-1": makeCommits(80), "wt-2": makeCommits(3) }),
    );
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    const { rerender } = render(<VcsPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("Commits (50)");
    await user.click(screen.getByRole("button", { name: /load 50 more/i }));
    await screen.findByText("Commits (80)");

    rerender(<VcsPanel api={api} worktreeId="wt-2" />);
    // Resets to one page (limit 51), not a continuation of wt-1's advanced
    // pageLimit (which would have requested 101).
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("wt-2", 51));
    await screen.findByText("Commits (3)");
  });

  it("Requirement 1f — Load more auto-turns the toggle OFF when the newly loaded page adds no own commits", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    // Page 1 (50 commits): all own. Page 2 adds 10 more, all upstream — the
    // common "everything past page 1 is base-branch history" shape.
    vi.spyOn(api, "listCommits").mockImplementation(
      limitAwareListCommits({ "wt-1": makeCommits(60, { isOnBranch: (i) => i < 50 }) }),
    );
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await screen.findByText("Commits (50)");
    expect(screen.queryByText("commit #55")).not.toBeInTheDocument();
    const toggle = screen.getByRole("checkbox", { name: /diff from main/i });
    expect(toggle).toBeChecked();

    await user.click(screen.getByRole("button", { name: /load 50 more/i }));

    // Without the auto-toggle-off, this commit would be loaded but still
    // filtered out by the ON toggle — clicking "Load more" would be a
    // no-visible-op.
    await screen.findByText("commit #55");
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("Commits (60)")).toBeInTheDocument();
  });

  it("Requirement 1f (negative) — Load more that DOES add own commits leaves the toggle ON", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    // Page 1 (50 commits): all own. Page 2 adds 10 more, still all own.
    vi.spyOn(api, "listCommits").mockImplementation(limitAwareListCommits({ "wt-1": makeCommits(60) }));
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await screen.findByText("Commits (50)");
    const toggle = screen.getByRole("checkbox", { name: /diff from main/i });

    await user.click(screen.getByRole("button", { name: /load 50 more/i }));

    await screen.findByText("commit #55");
    expect(toggle).toBeChecked();
    expect(screen.getByText("Commits (60)")).toBeInTheDocument();
  });

  it("Requirement 8 — a stale in-flight Load more for the previous worktree never overwrites the new worktree's state", async () => {
    const api = createMockApi();
    const wt1First = deferred<CommitLogEntry[]>();
    const spy = vi
      .spyOn(api, "listCommits")
      .mockImplementationOnce(() => Promise.resolve(makeCommits(80).slice(0, 51))) // wt-1 initial load
      .mockImplementationOnce(() => wt1First.promise) // wt-1 "Load more" — held open
      .mockImplementation(limitAwareListCommits({ "wt-2": makeCommits(3) })); // wt-2 initial load
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    const user = userEvent.setup();
    const { rerender } = render(<VcsPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("Commits (50)");
    await user.click(screen.getByRole("button", { name: /load 50 more/i }));
    // wt-1's "Load more" is now in flight and held open by `wt1First`.

    rerender(<VcsPanel api={api} worktreeId="wt-2" />);
    await screen.findByText("Commits (3)");

    // Now let the stale wt-1 response resolve — it must be discarded, not
    // clobber wt-2's already-rendered state.
    wt1First.resolve(makeCommits(80).slice(0, 101));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("Commits (3)")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("Regression — a failed Load more (toggle ON) doesn't leave stale armed state that flips the toggle OFF on a later unrelated Refresh", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.spyOn(api, "listCommits")
      // Initial load: 3 own commits, then 60 upstream — more than a page, so
      // "Load more" is available.
      .mockImplementationOnce(limitAwareListCommits({ "wt-1": makeCommits(63, { isOnBranch: (i) => i < 3 }) }))
      // "Load more" fails outright.
      .mockRejectedValueOnce(new Error("network blip"))
      // Refresh after the failure: same 3 own commits as before the failed
      // "Load more" — previously, the still-armed `pendingLoadMoreRef` would
      // treat this unrelated refresh as "the load-more's own-count didn't
      // grow" and spuriously flip the toggle OFF.
      .mockImplementation(limitAwareListCommits({ "wt-1": makeCommits(63, { isOnBranch: (i) => i < 3 }) }));
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await screen.findByText("Commits (3)");
    const toggle = screen.getByRole("checkbox", { name: /diff from main/i });
    expect(toggle).toBeChecked();

    await user.click(screen.getByRole("button", { name: /load 50 more/i }));
    await screen.findByText(/failed to load more/i);
    expect(toggle).toBeChecked();

    await user.click(screen.getByRole("button", { name: /refresh commits/i }));
    await waitFor(() => expect(screen.queryByText(/failed to load more/i)).not.toBeInTheDocument());
    expect(screen.getByText("Commits (3)")).toBeInTheDocument();
    expect(toggle).toBeChecked();
  });

  it("Regression — Load more / server-cap footer still shows when the toggle (ON) filters the page down to zero own commits", async () => {
    const api = createMockApi();
    // 200 upstream commits, zero own commits — a fresh branch off a large
    // base. Toggle defaults ON, so `displayedCommits` is empty even though
    // there's a full page (and more) of underlying commits.
    vi.spyOn(api, "listCommits").mockImplementation(
      limitAwareListCommits({ "wt-1": makeCommits(200, { isOnBranch: () => false }) }),
    );
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);

    await screen.findByText("No commits on this branch yet");
    // The pager must still render alongside the empty state — otherwise
    // there's no way to reach more history or discover the toggle.
    expect(screen.getByRole("button", { name: /load 50 more/i })).toBeInTheDocument();
  });

  it("Regression — submodules from the previous worktree are cleared immediately on worktree switch, not left stale until the new fetch resolves", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listCommits").mockImplementation(
      limitAwareListCommits({ "wt-1": makeCommits(2), "wt-2": makeCommits(2) }),
    );
    vi.spyOn(api, "getPr").mockResolvedValue(null);
    const wt1Submodules: SubmoduleInfo[] = [
      {
        path: "vendor/old",
        sha: "a1b2c3d4e5f6789012345678901234567890abcd",
        shortSha: "a1b2c3d",
        branch: null,
        subject: null,
        status: "clean",
      },
    ];
    const wt2Deferred = deferred<SubmoduleInfo[]>();
    const submoduleSpy = vi
      .spyOn(api, "listSubmodules")
      .mockResolvedValueOnce(wt1Submodules)
      .mockImplementationOnce(() => wt2Deferred.promise);

    const { rerender } = render(<VcsPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("vendor/old");

    rerender(<VcsPanel api={api} worktreeId="wt-2" />);
    // wt-2's submodules fetch is still in flight — the stale wt-1 row must
    // already be gone, not lingering until it resolves.
    await waitFor(() => expect(screen.queryByText("vendor/old")).not.toBeInTheDocument());

    wt2Deferred.resolve([]);
    await waitFor(() => expect(submoduleSpy).toHaveBeenCalledTimes(2));
  });

  it("Regression — the diff-from-main toggle resets to ON when switching worktrees, even after being turned OFF on the previous one", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.spyOn(api, "listCommits").mockImplementation(
      limitAwareListCommits({ "wt-1": makeCommits(3), "wt-2": makeCommits(3) }),
    );
    vi.spyOn(api, "getPr").mockResolvedValue(null);

    const { rerender } = render(<VcsPanel api={api} worktreeId="wt-1" baseBranch="main" />);
    await screen.findByText("Commits (3)");
    const toggle = screen.getByRole("checkbox", { name: /diff from main/i });
    await user.click(toggle);
    expect(toggle).not.toBeChecked();

    rerender(<VcsPanel api={api} worktreeId="wt-2" baseBranch="main" />);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /diff from main/i })).toBeChecked());
  });

  it("Requirement 3f — a non-empty submodules list renders a Submodules section; an empty one renders nothing", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listCommits").mockImplementation(limitAwareListCommits({ "wt-1": makeCommits(2) }));
    vi.spyOn(api, "getPr").mockResolvedValue(null);
    const submodules: SubmoduleInfo[] = [
      {
        path: "vendor/widget",
        sha: "a1b2c3d4e5f6789012345678901234567890abcd",
        shortSha: "a1b2c3d",
        branch: "main",
        subject: "Bump widget renderer",
        status: "clean",
      },
      {
        path: "vendor/legacy",
        sha: "0011223344556677889900112233445566778899",
        shortSha: "0011223",
        branch: null,
        subject: null,
        status: "uninitialized",
      },
    ];
    vi.spyOn(api, "listSubmodules").mockResolvedValue(submodules);

    const { rerender } = render(<VcsPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("Submodules");
    expect(screen.getByText("vendor/widget")).toBeInTheDocument();
    expect(screen.getByText("Bump widget renderer")).toBeInTheDocument();
    expect(screen.getByText("vendor/legacy")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();

    vi.spyOn(api, "listSubmodules").mockResolvedValue([]);
    rerender(<VcsPanel api={api} worktreeId="wt-2" />);
    await waitFor(() => expect(screen.queryByText("Submodules")).not.toBeInTheDocument());
  });
});
