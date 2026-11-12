import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mode, Session } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { ArtifactStripItems } from "./ArtifactStrip";
import { makeRow } from "./testFixtures";

const coder: Session = {
  id: "a",
  worktreeId: "wt1",
  projectId: "p1",
  modeId: null,
  type: "agent",
  name: "Coder",
  isMain: false,
  state: "working",
  lifecycleState: "drafting",
  tmuxName: "a",
  createdAt: "2026-10-27T09:00:00.000Z",
  modeIcon: "codex",
};

const api = {
  pinArtifact: vi.fn(async (id: string, pinned: boolean) => ({ ...makeRow({ id }), pinned })),
  listModes: vi.fn(async () => [] as Mode[]),
  on: vi.fn(() => () => {}),
};

beforeEach(() => {
  useServerStore.setState({ projects: [], worktrees: [], sessions: [coder], loaded: true });
});

describe("ArtifactStripItems writer chip", () => {
  it("shows the writer as an agent chip titled 'Written by …'", () => {
    const { container } = render(<ArtifactStripItems api={api} scopeId="wt1" row={makeRow({ id: "x", writers: ["a"] })} />);
    const agent = container.querySelector(".chip .artifacts-agent")!;
    expect(agent).toHaveTextContent("Coder");
    expect(agent).toHaveAttribute("title", "Written by Coder");
    expect(agent.querySelector(".mode-icon")).not.toBeNull();
  });

  it("a deleted writer shows the deleted-agent chip", () => {
    const { container } = render(<ArtifactStripItems api={api} scopeId="wt1" row={makeRow({ id: "x", writers: ["gone"] })} />);
    const agent = container.querySelector(".chip .artifacts-agent")!;
    expect(agent).toHaveClass("artifacts-agent--deleted");
    expect(agent).toHaveTextContent("deleted agent");
    expect(agent).toHaveAttribute("title", "Written by deleted agent");
  });

  it("no writer recorded: no agent chip", () => {
    const { container } = render(<ArtifactStripItems api={api} scopeId="wt1" row={makeRow({ id: "x", writers: [] })} />);
    expect(container.querySelector(".artifacts-agent")).toBeNull();
  });

  it("shows the +1 element and updated title when there are multiple writers", () => {
    const reviewer: Session = {
      ...coder,
      id: "b",
      name: "Reviewer",
    };
    useServerStore.setState({ projects: [], worktrees: [], sessions: [coder, reviewer], loaded: true });
    const { container } = render(<ArtifactStripItems api={api} scopeId="wt1" row={makeRow({ id: "x", writers: ["a", "b"] })} />);
    const agent = container.querySelector(".chip .artifacts-agent")!;
    expect(agent).toHaveTextContent("Coder");
    expect(agent).toHaveAttribute("title", "Written by Coder and 1 more");
    const more = container.querySelector(".chip .artifacts-row__more-writers");
    expect(more).not.toBeNull();
    expect(more).toHaveTextContent("+1");
    expect(more).toHaveAttribute("title", "Reviewer");
    expect(more).toHaveAttribute("aria-label", "and 1 more: Reviewer");
  });
});
