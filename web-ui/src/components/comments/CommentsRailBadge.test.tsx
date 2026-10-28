import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CommentsRailBadge } from "./CommentsRailBadge";
import { makeComment } from "./testFixtures";
import { useCommentStore } from "./useCommentStore";

describe("CommentsRailBadge", () => {
  beforeEach(() => useCommentStore.getState().reset());

  it("nothing at 0, the count after, capped at 99+", () => {
    render(<CommentsRailBadge scopeId="wt-1" />);
    expect(document.querySelector(".comment-rail-badge")).toBeNull();
    act(() =>
      useCommentStore.getState().replace("wt-1", "worktree", { comments: [makeComment({ id: "a" }), makeComment({ id: "b", pin: 2 })], nextPin: 3, terminalDeliveries: [] }),
    );
    expect(screen.getByLabelText("2 comments")).toHaveTextContent("2");
    act(() =>
      useCommentStore.getState().replace("wt-1", "worktree", {
        comments: Array.from({ length: 120 }, (_, i) => makeComment({ id: `x${i}`, pin: i + 1 })),
        nextPin: 121,
        terminalDeliveries: [],
      }),
    );
    expect(screen.getByLabelText("120 comments")).toHaveTextContent("99+");
  });
});
