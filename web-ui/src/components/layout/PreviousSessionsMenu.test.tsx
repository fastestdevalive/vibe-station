import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PreviousSessionsMenu } from "./PreviousSessionsMenu";
import type { Session } from "@/api/types";

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: "s1",
    worktreeId: "wt-1",
    projectId: "p1",
    modeId: null,
    type: "agent",
    isMain: false,
    state: "working",
    lifecycleState: "working",
    tmuxName: "s1",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("PreviousSessionsMenu", () => {
  it("renders nothing without predecessors", () => {
    const s1 = makeSession({ id: "s1" });
    const { container } = render(
      <PreviousSessionsMenu activeSession={s1} sessions={[s1]} onOpen={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists predecessors newest-first and clicking an entry calls onOpen(id)", () => {
    const onOpen = vi.fn();
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b" });
    const b = makeSession({ id: "b", name: "Session B", supersededBy: "c" });
    const c = makeSession({ id: "c", name: "Session C" });
    const sessions = [a, b, c];

    render(
      <PreviousSessionsMenu activeSession={c} sessions={sessions} onOpen={onOpen} />,
    );

    const button = screen.getByRole("button", { name: "Previous sessions" });
    expect(button).toBeDefined();

    fireEvent.click(button);

    const menu = screen.getByRole("menu", { name: "Previous sessions" });
    expect(menu).toBeDefined();

    const items = screen.getAllByRole("menuitem");
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toContain("Session B");
    expect(items[1]!.textContent).toContain("Session A");

    fireEvent.click(items[1]!);
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("'Back to current' appears when activeSession is a predecessor and calls onOpen(headId)", () => {
    const onOpen = vi.fn();
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    // activeSession is predecessor 'a'
    render(
      <PreviousSessionsMenu activeSession={a} sessions={sessions} onOpen={onOpen} />,
    );

    const button = screen.getByRole("button", { name: "Previous sessions" });
    fireEvent.click(button);

    const backBtn = screen.getByRole("menuitem", { name: "Back to current" });
    expect(backBtn).toBeDefined();

    // In the list of predecessors, 'a' should also show "Viewing"
    const aItem = screen.getByRole("menuitem", { name: /Session A.*Viewing/ });
    expect(aItem).toBeDefined();

    fireEvent.click(backBtn);
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("closes on Escape", async () => {
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu activeSession={b} sessions={sessions} onOpen={vi.fn()} />,
    );

    const button = screen.getByRole("button", { name: "Previous sessions" });
    fireEvent.click(button);

    expect(screen.getByRole("menu", { name: "Previous sessions" })).toBeDefined();

    // Trigger keydown Escape on document
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "Previous sessions" })).toBeNull();
  });

  it("archivedAt '1791675665580' (numeric string) renders a label with no 'Invalid Date'", () => {
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b", archivedAt: "1791675665580" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu activeSession={b} sessions={sessions} onOpen={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));
    const item = screen.getByRole("menuitem");
    expect(item.textContent).not.toContain("Invalid Date");
    expect(item.textContent).toMatch(/Session A \(\d+:\d+/);
  });

  it("an ISO string renders no 'Invalid Date'", () => {
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b", archivedAt: "2026-10-10T16:00:00.000Z" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu activeSession={b} sessions={sessions} onOpen={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));
    const item = screen.getByRole("menuitem");
    expect(item.textContent).not.toContain("Invalid Date");
    expect(item.textContent).toMatch(/Session A \(\d+:\d+/);
  });

  it("garbage 'not-a-date' renders just the label with no '(' suffix", () => {
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b", archivedAt: "not-a-date" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu activeSession={b} sessions={sessions} onOpen={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));
    const item = screen.getByRole("menuitem");
    expect(item.textContent).toBe("Session A");
    expect(item.textContent).not.toContain("(");
  });
});

