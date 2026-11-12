import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "@/api/types";
import { ArtifactRow } from "./ArtifactRow";
import { makeRow } from "./testFixtures";

const planner: Session = {
  id: "a",
  worktreeId: "wt1",
  projectId: "p1",
  modeId: null,
  type: "agent",
  name: "Planner",
  isMain: false,
  state: "working",
  lifecycleState: "drafting",
  tmuxName: "a",
  createdAt: "2026-10-27T09:00:00.000Z",
  modeIcon: "claude",
};

function renderRow(row: ReturnType<typeof makeRow>, writer: Session | null | undefined) {
  const { container } = render(
    <ArtifactRow
      row={row}
      writer={writer}
      selected={false}
      tabbable
      mobile
      menuOpen={false}
      onOpen={vi.fn()}
      onFocusRow={vi.fn()}
      onMenu={vi.fn()}
      setRef={vi.fn()}
    />,
  );
  return container.querySelector(".artifacts-row__sub")!;
}

describe("ArtifactRow sub-line (phone layout)", () => {
  it("the sub-line is a plain path line, then the writer chip with its mode icon, then the edits", () => {
    const sub = renderRow(makeRow({ id: "x", displayPath: "~/.claude/plans/x.md", inRepo: false, writers: ["a"], editCount: 3 }), planner);
    expect(sub.querySelector(".artifacts-row__path")).toHaveTextContent("outside repo · ~/.claude/plans/");
    expect(sub.querySelector(".chip")).toBeNull();
    const by = sub.querySelector(".artifacts-row__by")!;
    expect(by).toHaveTextContent("Planner");
    expect(by.querySelector(".mode-icon")).not.toBeNull();
    expect(sub.querySelector(".artifacts-row__edits")).toHaveTextContent("· 3 edits");
    expect(Array.from(sub.children).map((c) => c.className)).toEqual(["artifacts-row__path", "artifacts-agent artifacts-row__by", "artifacts-row__edits"]);
  });

  it("a row without a recorded writer shows no writer chip", () => {
    const sub = renderRow(makeRow({ id: "y", writers: [] }), undefined);
    expect(sub.querySelector(".artifacts-row__path")).toHaveTextContent("docs/");
    expect(sub.querySelector(".artifacts-row__by")).toBeNull();
    expect(sub.querySelector(".artifacts-agent")).toBeNull();
  });

});

describe("ArtifactRow more-writers badge (desktop)", () => {
  it("renders the +N element with the other writers' names as title when moreWriters > 0", () => {
    const { container } = render(
      <ArtifactRow
        row={makeRow({ id: "x", writers: ["a", "b"] })}
        writer={planner}
        moreWriters={1}
        otherWriters="Agent B"
        selected={false}
        tabbable
        mobile={false}
        menuOpen={false}
        onOpen={vi.fn()}
        onFocusRow={vi.fn()}
        onMenu={vi.fn()}
        setRef={vi.fn()}
      />,
    );
    const more = container.querySelector(".artifacts-row__more-writers");
    expect(more).not.toBeNull();
    expect(more).toHaveTextContent("+1");
    expect(more).toHaveAttribute("title", "Agent B");
    expect(more).toHaveAttribute("aria-label", "and 1 more: Agent B");
  });

  it("renders no +N element when moreWriters is 0", () => {
    const { container } = render(
      <ArtifactRow
        row={makeRow({ id: "x", writers: ["a"] })}
        writer={planner}
        moreWriters={0}
        selected={false}
        tabbable
        mobile={false}
        menuOpen={false}
        onOpen={vi.fn()}
        onFocusRow={vi.fn()}
        onMenu={vi.fn()}
        setRef={vi.fn()}
      />,
    );
    expect(container.querySelector(".artifacts-row__more-writers")).toBeNull();
  });
});
