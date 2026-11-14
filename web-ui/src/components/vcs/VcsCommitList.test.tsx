import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { CommitLogEntry } from "@/api/types";
import { resetVcsCacheForTests, useVcsCacheStore, vcsKey } from "./vcsCacheStore";
import { resetVcsRevalidationForTests } from "./useVcsCommits";
import { VcsCommitList } from "./VcsCommitList";

const KEY = vcsKey("worktree", "wt1");

function commit(i: number, onBranch: boolean): CommitLogEntry {
  return {
    sha: `${i}`.padStart(40, "c"),
    shortSha: `c${i}`,
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.com",
    date: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    subject: `subject ${i}`,
    body: `subject ${i}`,
    insertions: 3,
    deletions: 1,
    hasBinaryChanges: false,
    isOnBranch: onBranch,
  };
}

/** Fills the cache so the list paints without a request; the revalidation reply is never used here. */
function seeded(commits: CommitLogEntry[]) {
  const api = {
    listCommits: vi.fn(() => new Promise<CommitLogEntry[]>(() => {})),
    focusWorktree: vi.fn(async () => {}),
    getPr: vi.fn(async () => null),
  } as unknown as ApiInstance;
  useVcsCacheStore.getState().replace(KEY, commits, 50);
  return api;
}

function renderList(props: Partial<Parameters<typeof VcsCommitList>[0]> & { api: ApiInstance }) {
  return render(
    <VcsCommitList
      id="wt1"
      scope="worktree"
      baseBranch="main"
      onOpen={vi.fn()}
      sinceMain={true}
      onSinceMainChange={vi.fn()}
      {...props}
    />,
  );
}

describe("VcsCommitList", () => {
  beforeEach(() => {
    resetVcsCacheForTests();
    resetVcsRevalidationForTests();
  });

  it("a whole-row click calls onOpen with the commit sha", () => {
    const onOpen = vi.fn();
    const api = seeded([commit(1, true), commit(2, true)]);
    renderList({ api, onOpen });
    fireEvent.click(screen.getByTitle("subject 2"));
    expect(onOpen).toHaveBeenCalledWith(commit(2, true).sha);
  });

  it("'from main' divider sits before the first upstream row when all history is shown", () => {
    const api = seeded([commit(1, true), commit(2, true), commit(3, false), commit(4, false)]);
    const { container, rerender } = renderList({ api, sinceMain: false });
    const items = Array.from(container.querySelectorAll(".vcs-list > li"));
    expect(items[2]).toHaveClass("vcs-list__divider");
    expect(items[2]).toHaveTextContent("from main");
    expect(items).toHaveLength(5);
    rerender(
      <VcsCommitList id="wt1" scope="worktree" baseBranch="main" api={api} onOpen={vi.fn()} sinceMain onSinceMainChange={vi.fn()} />,
    );
    expect(container.querySelector(".vcs-list__divider")).toBeNull();
    expect(container.querySelectorAll(".vcs-list > li")).toHaveLength(2);
  });

  it("the header has the range dropdown and no branch chip or separate refresh icon", () => {
    const api = seeded([commit(1, true)]);
    const { container } = renderList({ api });
    expect(screen.getByRole("button", { name: "Commit range" })).toHaveTextContent("since main");
    expect(container.querySelector(".vcs-panel__branch-chip")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh commits" })).toBeNull();
  });

  it("compact (sidebar level 'list') drops the author and marks the active row", () => {
    const api = seeded([commit(1, true), commit(2, true)]);
    const { container } = renderList({ api, compact: true, activeSha: commit(2, true).sha });
    expect(container.querySelector(".vcs-row__author")).toBeNull();
    const active = container.querySelector(".vcs-row--active");
    expect(active).toHaveTextContent("subject 2");
    expect(active?.querySelector("button")).toHaveAttribute("aria-current", "true");
  });

  it("a cold load failure shows the error with a Retry that asks the API again", async () => {
    const api = {
      listCommits: vi.fn(async () => {
        throw new Error("Failed to fetch");
      }),
      focusWorktree: vi.fn(async () => {}),
      getPr: vi.fn(async () => null),
    } as unknown as ApiInstance;
    renderList({ api });
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText(/Failed to load commits: Failed to fetch/)).toBeInTheDocument();
    const callsBefore = vi.mocked(api.listCommits).mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(vi.mocked(api.listCommits).mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("the row shows subject, 'Author · 2h · sha' and the totals", () => {
    const api = seeded([commit(1, true)]);
    const { container } = renderList({ api });
    const row = container.querySelector(".vcs-row")!;
    expect(row.querySelector(".vcs-row__subject")).toHaveTextContent("subject 1");
    expect(row.querySelector(".vcs-row__meta")).toHaveTextContent("Ada Lovelace");
    expect(row.querySelector(".vcs-row__time")).toHaveTextContent("2h");
    expect(row.querySelector(".vcs-row__sha")).toHaveTextContent("c1");
    expect(row.querySelector(".vcs-row__add")).toHaveTextContent("+3");
    expect(row.querySelector(".vcs-row__del")).toHaveTextContent("−1");
  });
});
