import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChangedPathEntry } from "@/api/types";
import { makeComment } from "@/components/comments/testFixtures";
import { useCommentStore } from "@/components/comments/useCommentStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { ChangedFileList } from "./ChangedFileList";

const ENTRIES: ChangedPathEntry[] = [
  { path: "src/App.tsx", status: "M", insertions: 18, deletions: 9 },
  { path: "src/main.tsx", status: "M" },
];

describe("ChangedFileList pin chips (5.8, 5.T10)", () => {
  beforeEach(() => {
    useCommentStore.getState().reset();
    useWorkspaceStore.setState({ activeWorktreeId: "wt-1", activeFilePath: null });
  });

  it("shows a count chip left of the +/- stat per file, hidden at 0", () => {
    useCommentStore.getState().replace("wt-1", "worktree", {
      comments: [makeComment({ id: "a", pin: 1 }), makeComment({ id: "b", pin: 2 }), makeComment({ id: "c", pin: 3, path: "other.ts" })],
      nextPin: 4,
      terminalDeliveries: [],
    });
    render(<ChangedFileList scopeId="wt-1" entries={ENTRIES} />);
    const chip = screen.getByRole("img", { name: "2 comments" });
    expect(chip).toHaveAttribute("data-count", "2");
    expect(chip).toHaveTextContent("2");
    expect(chip.querySelector("svg")).not.toBeNull();
    const row = chip.closest('[role="treeitem"]')!;
    expect(row).toHaveAttribute("aria-label", "src/App.tsx");
    // left of the +/- numbers
    expect(chip.compareDocumentPosition(row.querySelector(".changed-file-list-file__loc")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /comment/ })).toHaveLength(1);
  });

  it("singular label, live update, and none in the controlled (commit) view", () => {
    useCommentStore.getState().replace("wt-1", "worktree", { comments: [makeComment({ id: "a", path: "src/main.tsx" })], nextPin: 2, terminalDeliveries: [] });
    const { rerender } = render(<ChangedFileList scopeId="wt-1" entries={ENTRIES} />);
    expect(screen.getByRole("img", { name: "1 comment" })).toBeInTheDocument();
    act(() => useCommentStore.getState().removeLocal("wt-1", ["a"]));
    expect(screen.queryByRole("img", { name: /comment/ })).not.toBeInTheDocument();
    act(() => useCommentStore.getState().upsertLocal(makeComment({ id: "z", pin: 2, path: "src/main.tsx" })));
    expect(screen.getByRole("img", { name: "1 comment" })).toBeInTheDocument();
    rerender(<ChangedFileList scopeId="wt-1" entries={ENTRIES} controlled={{ activePath: null, onSelect: () => {} }} />);
    expect(screen.queryByRole("img", { name: /comment/ })).not.toBeInTheDocument();
  });
});
