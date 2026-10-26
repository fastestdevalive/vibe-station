import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PreviousSessionsMenu } from "./PreviousSessionsMenu";
import { useModesStore } from "@/store/modesStore";
import type { ApiInstance } from "@/api";
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

function makeApi(overrides: Partial<Record<"listSessions" | "listModes", ReturnType<typeof vi.fn>>> = {}) {
  return {
    listSessions: vi.fn().mockResolvedValue([] as Session[]),
    listModes: vi.fn().mockResolvedValue([]),
    getSupportedClis: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ApiInstance;
}

/** Seed the shared modes cache so CLI resolution is deterministic. */
function seedModes(modes: Array<{ id: string; cli: string }>) {
  useModesStore.setState({
    loaded: true,
    modes: new Map(modes.map((m) => [m.id, { id: m.id, name: m.id, cli: m.cli, context: "" } as never])),
  });
}

describe("PreviousSessionsMenu", () => {
  beforeEach(() => {
    useModesStore.getState()._reset();
  });

  it("renders nothing without predecessors", () => {
    const s1 = makeSession({ id: "s1" });
    const { container } = render(
      <PreviousSessionsMenu api={makeApi()} activeSession={s1} sessions={[s1]} onOpen={vi.fn()} />,
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
      <PreviousSessionsMenu
        api={makeApi()}
        activeSession={c}
        sessions={sessions}
        onOpen={onOpen}
      />,
    );

    const button = screen.getByRole("button", { name: "Previous sessions" });
    expect(button).toBeDefined();

    fireEvent.click(button);

    const menu = screen.getByRole("menu", { name: "Previous sessions" });
    expect(menu).toBeDefined();

    const openers = screen.getAllByRole("button", { name: /Session [AB]/ });
    expect(openers.length).toBe(2);
    expect(openers[0]!.textContent).toContain("Session B");
    expect(openers[1]!.textContent).toContain("Session A");

    fireEvent.click(openers[1]!);
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("'Back to current' appears when activeSession is a predecessor and calls onOpen(headId)", () => {
    const onOpen = vi.fn();
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu
        api={makeApi()}
        activeSession={a}
        sessions={sessions}
        onOpen={onOpen}
      />,
    );

    const button = screen.getByRole("button", { name: "Previous sessions" });
    fireEvent.click(button);

    const backBtn = screen.getByRole("menuitem", { name: "Back to current" });
    expect(backBtn).toBeDefined();

    fireEvent.click(backBtn);
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("shows CLI chip and reset-vs-switch label vs the predecessor's successor", () => {
    seedModes([
      { id: "m-claude", cli: "claude" },
      { id: "m-cursor", cli: "cursor" },
    ]);
    // a (claude) -> b (cursor): switch. b (cursor) -> c (cursor): reset.
    const a = makeSession({ id: "a", name: "Session A", modeId: "m-claude", supersededBy: "b" });
    const b = makeSession({ id: "b", name: "Session B", modeId: "m-cursor", supersededBy: "c" });
    const c = makeSession({ id: "c", name: "Session C", modeId: "m-cursor" });
    const sessions = [a, b, c];

    render(
      <PreviousSessionsMenu
        api={makeApi()}
        activeSession={c}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));

    const aEntry = screen.getByText("Session A").closest(".prev-session");
    expect(aEntry).toBeDefined();
    expect(aEntry!.textContent).toContain("claude");
    expect(aEntry!.textContent).toContain("Switched to m-cursor");

    const bEntry = screen.getByText("Session B").closest(".prev-session");
    expect(bEntry!.textContent).toContain("cursor");
    expect(bEntry!.textContent).toContain("Started fresh");
  });

  it("expands the handoff summary and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const a = makeSession({
      id: "a",
      name: "Session A",
      supersededBy: "b",
      handoffSummary: "Goal: stream the tokenizer.\nDone: tokenize_stream().",
    });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu
        api={makeApi()}
        activeSession={b}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));

    // Collapsed by default — no summary text yet.
    expect(screen.queryByText(/Goal: stream the tokenizer/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show summary/ }));

    expect(screen.getByText(/Goal: stream the tokenizer/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Copy summary/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(a.handoffSummary));
  });

  it.each([
    ["none", "Nothing carried over"],
    ["summary", "Summary carried over"],
    ["transcript", "Transcript linked"],
  ] as const)("labels a %s predecessor with what was carried", (carryOver, label) => {
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b", carryOver });
    const b = makeSession({ id: "b", name: "Session B" });

    render(
      <PreviousSessionsMenu api={makeApi()} activeSession={b} sessions={[a, b]} onOpen={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));

    expect(screen.getByText(label)).toBeDefined();
    // No summary text recorded -> no summary toggle.
    expect(screen.queryByText(/Show summary/)).toBeNull();
  });

  it("says carry-over was not recorded for a predecessor archived before the field existed", () => {
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b" });
    const b = makeSession({ id: "b", name: "Session B" });

    render(
      <PreviousSessionsMenu api={makeApi()} activeSession={b} sessions={[a, b]} onOpen={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));

    expect(screen.getByText("Carry-over not recorded")).toBeDefined();
    expect(screen.queryByText(/Show summary/)).toBeNull();
  });

  it("refreshes sessions via listSessions on open", async () => {
    const listSessions = vi.fn().mockResolvedValue([makeSession({ id: "b", name: "Session B" })]);
    const api = makeApi({ listSessions });

    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu api={api} activeSession={b} sessions={sessions} onOpen={vi.fn()} />,
    );

    expect(listSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));

    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    // Worktree scope of the head session is used for the refresh.
    expect(listSessions).toHaveBeenCalledWith("wt-1");
  });

  it("closes on Escape", async () => {
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu
        api={makeApi()}
        activeSession={b}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "Previous sessions" });
    fireEvent.click(button);

    expect(screen.getByRole("menu", { name: "Previous sessions" })).toBeDefined();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "Previous sessions" })).toBeNull();
  });

  it("archivedAt '1791675665580' (numeric string) renders a label with no 'Invalid Date'", () => {
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b", archivedAt: "1791675665580" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu
        api={makeApi()}
        activeSession={b}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));
    const item = screen.getByText("Session A").closest(".prev-session");
    expect(item!.textContent).not.toContain("Invalid Date");
    expect(item!.textContent).toMatch(/Session A.*\d+:\d+/);
  });

  it("an ISO string renders no 'Invalid Date'", () => {
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b", archivedAt: "2026-10-10T16:00:00.000Z" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu
        api={makeApi()}
        activeSession={b}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));
    const item = screen.getByText("Session A").closest(".prev-session");
    expect(item!.textContent).not.toContain("Invalid Date");
    expect(item!.textContent).toMatch(/Session A.*\d+:\d+/);
  });

  it("garbage 'not-a-date' renders just the label with no '(' suffix", () => {
    const a = makeSession({ id: "a", name: "Session A", supersededBy: "b", archivedAt: "not-a-date" });
    const b = makeSession({ id: "b", name: "Session B" });
    const sessions = [a, b];

    render(
      <PreviousSessionsMenu
        api={makeApi()}
        activeSession={b}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));
    const item = screen.getByText("Session A").closest(".prev-session");
    expect(item!.textContent).not.toContain("Invalid Date");
    expect(item!.textContent).not.toContain("undefined");
    expect(item!.textContent).not.toContain("NaN");
  });
});
