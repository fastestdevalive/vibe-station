import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRow, Mode, Session, SessionState } from "@/api/types";
import { ApiError } from "@/api/errors";
import { useDetailsStore } from "@/components/details/detailsStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { __resetForDemo, useModesStore } from "@/store/modesStore";
import { ArtifactsList } from "./ArtifactsList";
import { otherWriterCount, otherWriterNames, writerOf } from "./artifactSessions";
import { useArtifactsStore } from "./artifactsStore";
import { makeRow, upsert } from "./testFixtures";

const renderRowCounter = vi.hoisted(() => ({ count: 0 }));
vi.mock("./ArtifactRow", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./ArtifactRow")>();
  const Real = mod.ArtifactRow;
  // memo mirrors the real component: the count only grows when a row's props actually change.
  const Counted = memo(function Counted(props: React.ComponentProps<typeof Real>) {
    renderRowCounter.count++;
    return <Real {...props} />;
  });
  return { ...mod, ArtifactRow: Counted };
});

const S = "wt1";

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    worktreeId: S,
    projectId: "p1",
    modeId: null,
    type: "agent",
    name: id,
    isMain: false,
    state: "working",
    lifecycleState: "drafting",
    tmuxName: id,
    createdAt: "2026-10-27T09:00:00.000Z",
    ...over,
  };
}

function makeApi() {
  return {
    listArtifacts: vi.fn(async () => ({ rev: 1, cap: 500, total: 0, items: [] as ArtifactRow[] })),
    pinArtifact: vi.fn(async (id: string, pinned: boolean) => ({ ...makeRow({ id }), pinned })),
    removeArtifact: vi.fn(async () => ({ ok: true as const })),
    listModes: vi.fn(async () => [] as Mode[]),
    on: vi.fn(() => () => {}),
  };
}

function seed(rows: ArtifactRow[], opts: { total?: number; cap?: number; sessions?: Session[]; states?: Record<string, SessionState> } = {}) {
  useServerStore.setState({ projects: [], worktrees: [], sessions: opts.sessions ?? [session("s-run")], loaded: true });
  useWorkspaceStore.setState({ sessionStates: opts.states ?? {} });
  useArtifactsStore.getState().replace(S, "worktree", { rev: 1, cap: opts.cap ?? 500, total: opts.total ?? rows.length, items: rows });
}

function renderList(api = makeApi(), props: Partial<React.ComponentProps<typeof ArtifactsList>> = {}) {
  const view = render(<ArtifactsList api={api} worktreeId={S} scope="worktree" {...props} />);
  return { api, ...view };
}

const names = () => within(screen.queryByRole("listbox") ?? document.body).queryAllByRole("option").map((o) => o.querySelector(".artifacts-row__name")?.textContent);

beforeEach(() => {
  useArtifactsStore.getState().reset();
  useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
});
afterEach(() => vi.useRealTimers());

describe("ArtifactsList groups (7.T1)", () => {
  const sessions = [session("s-run"), session("s-old", { state: "exited" })];
  const rows = [
    makeRow({ id: "pin", pinned: true, writers: ["s-old"], lastWrittenAt: "2026-10-27T10:05:00.000Z" }),
    makeRow({ id: "run", writers: ["s-run"], lastWrittenAt: "2026-10-27T10:04:00.000Z" }),
    makeRow({ id: "old", writers: ["s-old"], lastWrittenAt: "2026-10-27T10:03:00.000Z" }),
    makeRow({ id: "gone", writers: ["deleted-id"], lastWrittenAt: "2026-10-27T10:02:00.000Z" }),
  ];

  it("pinned on top, running writer in This run, exited/deleted in Earlier (collapsed, toggles), counts in headers", async () => {
    seed(rows, { sessions });
    renderList();
    expect(screen.getByRole("group", { name: "Pinned, 1 artifact" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "This run, 1 artifact" })).toBeInTheDocument();
    expect(names()).toEqual(["pin.md", "run.md"]);

    const earlier = screen.getByRole("button", { name: "Earlier, 2 artifacts" });
    expect(earlier).toHaveAttribute("aria-expanded", "false");
    // The "· N" count is gone from the group header; the count lives in the aria-label.
    expect(earlier).toHaveTextContent(/^Earlier$/);
    await userEvent.click(earlier);
    expect(earlier).toHaveAttribute("aria-expanded", "true");
    expect(names()).toEqual(["pin.md", "run.md", "old.md", "gone.md"]);
    await userEvent.click(earlier);
    expect(names()).toEqual(["pin.md", "run.md"]);
  });

  it("collapse state survives a remount of the same scope; other scopes keep the defaults", async () => {
    seed([makeRow({ id: "r", writers: ["s-run"] })]);
    const first = renderList();
    await userEvent.click(screen.getByRole("button", { name: "This run, 1 artifact" }));
    expect(screen.getByRole("button", { name: "This run, 1 artifact" })).toHaveAttribute("aria-expanded", "false");
    first.unmount();
    renderList();
    expect(screen.getByRole("button", { name: "This run, 1 artifact" })).toHaveAttribute("aria-expanded", "false");
    expect(useArtifactsStore.getState().groupOpen.other).toBeUndefined();
  });

  it("This run collapses too, and the Pinned header is not a toggle", async () => {
    seed(rows, { sessions });
    renderList();
    const run = screen.getByRole("button", { name: "This run, 1 artifact" });
    expect(run).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(run);
    expect(names()).toEqual(["pin.md"]);
    expect(screen.queryByRole("button", { name: /^Pinned/ })).toBeNull();
  });

  it("any live writer in `writers` (not just the newest) puts the row in This run", () => {
    seed([makeRow({ id: "two", writers: ["s-old", "s-run"] })], { sessions });
    renderList();
    expect(screen.getByRole("group", { name: "This run, 1 artifact" })).toBeInTheDocument();
  });

  it("an archived session is not live", () => {
    seed([makeRow({ id: "a", writers: ["s-arch"] })], { sessions: [session("s-arch", { archivedAt: "2026-10-27T09:30:00.000Z" })] });
    renderList();
    expect(screen.queryByRole("group", { name: /This run/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Earlier, 1 artifact" })).toBeInTheDocument();
  });

  it("header count shows the number of rows; the 'n of cap' meta is not shown unless the list is near its cap", () => {
    seed(rows, { sessions, total: 7 });
    renderList();
    expect(screen.getByLabelText("4 artifacts")).toHaveTextContent("4");
    expect(screen.queryByText("7 of 500")).toBeNull();
    expect(document.querySelector(".artifacts-foot")).toBeNull();
  });

  it("near the cap (within 10 rows) the 'n of cap' footer line shows", () => {
    seed(rows, { sessions, total: 5, cap: 5 });
    renderList();
    expect(document.querySelector(".artifacts-foot")).toHaveTextContent("5 of 5");
  });
});

describe("ArtifactsList agent filter (7.T2)", () => {
  const rows = [
    makeRow({ id: "by-main", writers: ["main"], lastWrittenAt: "2026-10-27T10:03:00.000Z" }),
    makeRow({ id: "by-child", writers: ["child"], lastWrittenAt: "2026-10-27T10:02:00.000Z" }),
    makeRow({ id: "by-b", writers: ["b"], lastWrittenAt: "2026-10-27T10:01:00.000Z" }),
    makeRow({ id: "multi", writers: ["b", "main"], lastWrittenAt: "2026-10-27T10:00:00.000Z" }),
  ];
  const three = [
    session("main", { name: "main", isMain: true, modeIcon: "claude", channel: "json" }),
    session("b", { name: "Agent B", modeIcon: "codex" }),
    session("c", { name: "Agent C", state: "idle" }),
    session("child", { name: "Sub", parentSessionId: "main" }),
  ];
  const trigger = () => screen.getByRole("button", { name: /^Filter by agent:/ });
  const agentList = () => names();

  it("the trigger reads All agents with the artifact count; no session wording anywhere", () => {
    seed(rows, { sessions: three });
    renderList();
    expect(trigger()).toHaveAccessibleName("Filter by agent: All agents");
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    // No count on "All agents": the "N of 500" meta beside it already says it.
    expect(trigger()).toHaveTextContent(/^All agents$/);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/session/i);
    expect(agentList()).toHaveLength(4);
  });

  it("options render as agent rows: All agents first, mode icon, name, live status, count; children fold into parents", async () => {
    seed(rows, { sessions: three, states: { b: "waiting_for_human" } });
    renderList();
    await userEvent.click(trigger());
    const menu = screen.getByRole("menu", { name: "Filter by agent" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual([
      "All agents, 4 artifacts",
      "main, working, 3 artifacts",
      "Agent B, waiting for human, 2 artifacts",
      "Agent C, idle, 0 artifacts",
    ]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
    expect(items[0]).toHaveFocus();
    // Live status comes from sessionStates first (b), falling back to session.state (c).
    expect(items[2]!.querySelector(".status-dot--waiting_for_human")).not.toBeNull();
    expect(items[3]!.querySelector(".status-dot--idle")).not.toBeNull();
    expect(items[1]!.querySelector(".mode-icon")).not.toBeNull();
    expect(items[1]!.querySelector(".mode-icon--terminal")).toBeNull();
    expect(items[2]!.querySelector(".mode-icon--terminal")).not.toBeNull();
    expect(menu.textContent).not.toMatch(/Sub/);
  });

  it("selecting a parent includes rows written by its children; any writer in `writers` matches", async () => {
    seed(rows, { sessions: three });
    renderList();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^main,/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger()).toHaveAccessibleName("Filter by agent: main");
    expect(trigger()).toHaveFocus();
    expect(agentList()).toEqual(["by-main.md", "by-child.md", "multi.md"]);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Agent B,/ }));
    expect(agentList()).toEqual(["by-b.md", "multi.md"]);
  });

  it("keyboard: ArrowDown opens on the checked item, arrows/Home/End move, Enter picks, Escape closes and returns focus", async () => {
    seed(rows, { sessions: three });
    renderList();
    trigger().focus();
    await userEvent.keyboard("{ArrowDown}");
    const items = () => screen.getAllByRole("menuitemradio");
    expect(items()[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(items()[2]).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(items()[3]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(items()[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{Home}{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(agentList()).toEqual(["by-b.md", "multi.md"]);

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: /^Agent B,/ })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(agentList()).toEqual(["by-b.md", "multi.md"]);
  });

  it("an outside click closes the menu without changing the filter", async () => {
    seed(rows, { sessions: three });
    renderList();
    await userEvent.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(agentList()).toHaveLength(4);
  });

  it("an agent with no artifacts shows the agent empty state", async () => {
    seed(rows, { sessions: three });
    renderList();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Agent C,/ }));
    expect(screen.getByText("No artifacts from this agent.")).toBeInTheDocument();
  });

  it("a selected agent that gets archived or deleted falls back to All agents and every row shows", async () => {
    seed(rows, { sessions: three });
    renderList();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Agent B,/ }));
    expect(agentList()).toEqual(["by-b.md", "multi.md"]);
    expect(trigger()).toHaveTextContent("Agent B2");

    act(() => useServerStore.setState({ sessions: three.map((s) => (s.id === "b" ? { ...s, archivedAt: "2026-10-27T11:00:00.000Z" } : s)) }));
    expect(trigger()).toHaveAccessibleName("Filter by agent: All agents");
    // An archived writer is not live: its row moves to the collapsed Earlier group.
    fireEvent.click(screen.getByRole("button", { name: "Earlier, 1 artifact" }));
    expect(agentList()).toHaveLength(4);

    act(() => useServerStore.setState({ sessions: three }));
    // Restored agent: the filter stays All, it does not silently re-apply.
    expect(trigger()).toHaveAccessibleName("Filter by agent: All agents");
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Agent C,/ }));
    act(() => useServerStore.setState({ sessions: three.filter((s) => s.id !== "c") }));
    expect(trigger()).toHaveAccessibleName("Filter by agent: All agents");
    expect(agentList()).toHaveLength(4);
  });

  it("Tab stays inside the open picker", async () => {
    seed(rows, { sessions: three });
    renderList();
    await userEvent.click(trigger());
    const items = screen.getAllByRole("menuitemradio");
    expect(items[0]).toHaveFocus();
    await userEvent.tab();
    expect(items[1]).toHaveFocus();
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    expect(items[items.length - 1]).toHaveFocus();
    expect(screen.getByRole("menu", { name: "Filter by agent" })).toBeInTheDocument();
  });

  it("loads the modes once for every icon in the list", async () => {
    __resetForDemo();
    useModesStore.setState({ modes: new Map(), loaded: false });
    seed(rows, { sessions: three });
    const { api } = renderList();
    await waitFor(() => expect(api.listModes).toHaveBeenCalledTimes(1));
    expect(api.on).toHaveBeenCalledWith("mode:updated", expect.any(Function));
  });

  it("the picker is used for many agents too and the 'N of 500' meta sits in the menu header", () => {
    seed(rows, { sessions: [...three, session("d", { name: "Agent D" }), session("e", { name: "Agent E" })] });
    renderList();
    expect(trigger()).toBeInTheDocument();
    expect(screen.queryByText(/of 500$/)).toBeNull();
    fireEvent.click(trigger());
    expect(screen.getByText(/of 500$/)).toBeInTheDocument();
  });
});

describe("ArtifactsList notices (7.T3, 7.T7)", () => {
  it("a created cli outside-repo upsert shows the added notice; Remove calls removeArtifact", async () => {
    seed([makeRow({ id: "a", writers: ["s1"] })], { sessions: [session("s1", { name: "Agent 1" })] });
    const { api } = renderList();
    act(() => {
      useArtifactsStore.getState().applyUpserted({
        scopeId: S,
        rev: 2,
        rows: [upsert({ id: "shot", path: "/tmp/shots/login.png", displayPath: "/tmp/shots/login.png", inRepo: false, kind: "image", addedVia: "cli", writers: ["s1"] }, true)],
      });
    });
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent("Agent 1 added /tmp/shots/login.png (outside the repo) ·");
    await userEvent.click(within(note).getByRole("button", { name: "Remove" }));
    expect(api.removeArtifact).toHaveBeenCalledWith("shot");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(names()).toEqual(["a.md"]);
  });

  it("an in-repo or non-created upsert shows no notice", () => {
    seed([makeRow({ id: "a" })]);
    renderList();
    act(() => {
      useArtifactsStore.getState().applyUpserted({ scopeId: S, rev: 2, rows: [upsert({ id: "in", addedVia: "cli", inRepo: true }, true)] });
      useArtifactsStore.getState().applyUpserted({ scopeId: S, rev: 3, rows: [upsert({ id: "a", addedVia: "cli", inRepo: false }, false)] });
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the added notice is dismissible", async () => {
    seed([makeRow({ id: "a" })]);
    renderList();
    act(() => {
      useArtifactsStore.getState().applyUpserted({ scopeId: S, rev: 2, rows: [upsert({ id: "o", addedVia: "cli", inRepo: false, displayPath: "/tmp/o.md", path: "/tmp/o.md" }, true)] });
    });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("cap notice shows the dropped count and auto-dismisses after 10 s", () => {
    vi.useFakeTimers();
    seed([makeRow({ id: "a", writers: ["s-run"] }), makeRow({ id: "b", writers: ["s-run"] })]);
    renderList();
    act(() => useArtifactsStore.getState().applyRemoved({ scopeId: S, rev: 2, ids: ["b"], reason: "cap" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 oldest artifact was dropped (limit 500). Pinned are kept.");
    act(() => void vi.advanceTimersByTime(9_900));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the cap notice and the added notice from the same burst render together", () => {
    seed([makeRow({ id: "a" }), makeRow({ id: "b" }), makeRow({ id: "c" }), makeRow({ id: "d" })]);
    renderList();
    act(() => {
      useArtifactsStore.getState().applyRemoved({ scopeId: S, rev: 2, ids: ["b", "c", "d"], reason: "cap" });
      useArtifactsStore.getState().applyUpserted({ scopeId: S, rev: 3, rows: [upsert({ id: "o", addedVia: "cli", inRepo: false, displayPath: "/tmp/o.md", path: "/tmp/o.md" }, true)] });
    });
    const notes = screen.getAllByRole("status");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveTextContent("3 oldest artifacts were dropped (limit 500). Pinned are kept.");
    expect(notes[1]).toHaveTextContent("(outside the repo)");
  });

  it("plural cap notice", () => {
    seed([makeRow({ id: "a" }), makeRow({ id: "b" }), makeRow({ id: "c" })]);
    renderList();
    act(() => useArtifactsStore.getState().applyRemoved({ scopeId: S, rev: 2, ids: ["b", "c"], reason: "cap" }));
    expect(screen.getByRole("status")).toHaveTextContent("2 oldest artifacts were dropped (limit 500). Pinned are kept.");
  });
});

describe("ArtifactsList row render (7.T4)", () => {
  it("name and dir spans carry the full display path as a title", () => {
    seed([makeRow({ id: "t", writers: ["s-run"], path: "/tmp/deep/dir/t.md", displayPath: "/tmp/deep/dir/t.md", inRepo: false })]);
    renderList();
    expect(document.querySelector(".artifacts-row__name")).toHaveAttribute("title", "/tmp/deep/dir/t.md");
    // The folder is no longer a path line: it appears only as a hint for same-named files.
    expect(document.querySelector(".artifacts-row__path")).toBeNull();
  });

  it("one line per row: no outside-repo chip, path, agent or edits; missing is struck through; deleted agent goes to Earlier; selected", () => {
    const now = Date.now();
    seed(
      [
        makeRow({ id: "out", path: "/home/u/.claude/plans/x.md", displayPath: "~/.claude/plans/x.md", inRepo: false, writers: ["s-run"], editCount: 3, lastWrittenAt: new Date(now - 120_000).toISOString() }),
        makeRow({ id: "miss", state: "missing", writers: ["s-run"], editCount: 4, displayPath: "docs/old.md", lastWrittenAt: new Date(now - 130_000).toISOString() }),
        makeRow({ id: "ghost", writers: ["nope"], lastWrittenAt: new Date(now - 140_000).toISOString() }),
      ],
      { sessions: [session("s-run", { name: "main" })] },
    );
    renderList(makeApi(), { selectedPath: "docs/old.md" });
    const out = screen.getAllByRole("option")[0]!;
    expect(out).toHaveTextContent(/^x\.md2m$/);
    expect(out.querySelector(".chip, .artifacts-row__by, .artifacts-row__edits, .artifacts-row__path")).toBeNull();
    expect(out).toHaveAttribute("aria-selected", "false");

    const miss = screen.getAllByRole("option")[1]!;
    expect(within(miss).getByText("missing")).toHaveClass("artifacts-row__missing");
    expect(miss).toHaveClass("artifacts-row--missing", "artifacts-row--selected");
    expect(miss).toHaveAttribute("aria-selected", "true");
    expect(miss).not.toHaveTextContent("edits");

    // deleted writer goes to Earlier
    fireEvent.click(screen.getByRole("button", { name: /^Earlier/ }));
    expect(screen.getByRole("option", { name: /ghost\.md/ })).toBeInTheDocument();
  });

  it("no outside-repo chip for an in-repo row; no edits text for a single edit", () => {
    seed([makeRow({ id: "a", writers: ["s-run"] })]);
    renderList();
    const row = screen.getByRole("option");
    expect(within(row).queryByText("outside repo")).toBeNull();
    expect(row).not.toHaveTextContent("edit");
  });
});

describe("ArtifactsList states (7.T5)", () => {
  it("empty state copy includes the from-now-on line and the vst artifact add hint", () => {
    seed([]);
    renderList();
    expect(screen.getByText("No artifacts yet")).toBeInTheDocument();
    expect(screen.getByText(/show up here from now on/)).toBeInTheDocument();
    expect(screen.getByText("vst artifact add <path>")).toBeInTheDocument();
  });

  it("loading shows five skeleton bars and aria-busy", () => {
    let release: (v: { rev: number; cap: number; total: number; items: ArtifactRow[] }) => void = () => {};
    const api = makeApi();
    api.listArtifacts.mockImplementation(() => new Promise((r) => (release = r)));
    const { container } = renderList(api);
    expect(container.querySelector(".artifacts-pane")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("artifacts-skeleton").children).toHaveLength(5);
    act(() => release({ rev: 1, cap: 500, total: 0, items: [] }));
  });

  it("error shows Retry and no stale rows; Retry refetches", async () => {
    seed([makeRow({ id: "stale" })]);
    useArtifactsStore.getState().setError(S, "worktree", "boom");
    const api = makeApi();
    api.listArtifacts.mockResolvedValue({ rev: 1, cap: 500, total: 1, items: [makeRow({ id: "fresh", writers: ["s-run"] })] });
    renderList(api);
    expect(screen.getByText("Couldn’t load artifacts")).toBeInTheDocument();
    expect(screen.getByText(/Showing nothing rather than a stale list/)).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(api.listArtifacts).toHaveBeenCalledWith(S, "worktree");
    await waitFor(() => expect(names()).toEqual(["fresh.md"]));
  });

  it("fetches the scope on first need", async () => {
    const api = makeApi();
    useServerStore.setState({ sessions: [session("s-run")], loaded: true });
    api.listArtifacts.mockResolvedValue({ rev: 1, cap: 500, total: 1, items: [makeRow({ id: "first", writers: ["s-run"] })] });
    renderList(api);
    await waitFor(() => expect(names()).toEqual(["first.md"]));
    expect(api.listArtifacts).toHaveBeenCalledTimes(1);
  });
});

describe("ArtifactsList menu and keyboard (7.T6)", () => {
  const sessions = [session("s-run")];
  const rows = [
    makeRow({ id: "pin", pinned: true, writers: ["s-run"], path: "/repo/docs/pin.md", lastWrittenAt: "2026-10-27T10:02:00.000Z" }),
    makeRow({ id: "r2", writers: ["s-run"], path: "/repo/docs/r2.md", lastWrittenAt: "2026-10-27T10:01:00.000Z" }),
  ];

  async function openMenu(name: RegExp) {
    const row = screen.getByRole("option", { name });
    const wrap = row.parentElement!;
    await userEvent.click(within(wrap).getByRole("button", { name: "Row actions" }));
    return screen.getByRole("menu");
  }

  it("Pin calls pinArtifact(id, true) and the menu offers Unpin for a pinned row", async () => {
    seed(rows, { sessions });
    const { api } = renderList();
    const menu = await openMenu(/r2\.md/);
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Pin", "Copy path", "Details", "Remove from artifacts"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Pin" }));
    expect(api.pinArtifact).toHaveBeenCalledWith("r2", true);
    await waitFor(() => expect(screen.getByRole("group", { name: "Pinned, 2 artifacts" })).toBeInTheDocument());

    const menu2 = await openMenu(/pin\.md/);
    expect(within(menu2).getByRole("menuitem", { name: "Unpin" })).toBeInTheDocument();
  });

  it("Remove of a pinned row calls removeArtifact and the row leaves Pinned", async () => {
    seed(rows, { sessions });
    const { api } = renderList();
    const menu = await openMenu(/pin\.md/);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove from artifacts" }));
    expect(api.removeArtifact).toHaveBeenCalledWith("pin");
    await waitFor(() => expect(screen.queryByRole("group", { name: /^Pinned/ })).toBeNull());
    expect(names()).toEqual(["r2.md"]);
  });

  it("Pin at the limit shows the inline notice", async () => {
    seed(rows, { sessions });
    const api = makeApi();
    api.pinArtifact.mockRejectedValue(new ApiError("limit", 409, "PIN_LIMIT"));
    renderList(api);
    const menu = await openMenu(/r2\.md/);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Pin" }));
    expect(await screen.findByText("50 pinned is the limit")).toBeInTheDocument();
  });

  it("Copy path writes the absolute path", async () => {
    seed(rows, { sessions });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderList();
    const menu = await openMenu(/r2\.md/);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith("/repo/docs/r2.md");
  });

  it("right-click opens the same menu; Esc closes it and focus returns to the row", async () => {
    seed(rows, { sessions });
    renderList();
    const row = screen.getByRole("option", { name: /r2\.md/ });
    row.focus();
    fireEvent.contextMenu(row);
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    await waitFor(() => expect(within(menu).getAllByRole("menuitem")[0]).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    expect(within(menu).getAllByRole("menuitem")[1]).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(row).toHaveFocus();
  });

  it("R1F-03: focus enters the first item only once the menu is visible", async () => {
    seed(rows, { sessions });
    renderList();
    const seen: { role: string | null; visibility: string | undefined }[] = [];
    const orig = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, ...a) {
      if (this.getAttribute("role") === "menuitem") {
        seen.push({ role: "menuitem", visibility: (this.closest('[role="menu"]') as HTMLElement | null)?.style.visibility });
      }
      return orig.apply(this, a as []);
    });
    await openMenu(/r2\.md/);
    spy.mockRestore();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.visibility).toBe("visible");
  });

  it("R1F-03: Esc dispatched outside the menu closes it and is not seen by bubble listeners", async () => {
    seed(rows, { sessions });
    renderList();
    await openMenu(/r2\.md/);
    const bubble = vi.fn();
    document.body.addEventListener("keydown", bubble);
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.body.removeEventListener("keydown", bubble);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(bubble).not.toHaveBeenCalled();
  });

  it("Tab stays inside the open menu", async () => {
    seed(rows, { sessions });
    renderList();
    const menu = await openMenu(/r2\.md/);
    const items = within(menu).getAllByRole("menuitem");
    items[items.length - 1]!.focus();
    await userEvent.tab();
    expect(items[0]).toHaveFocus();
  });

  it("the Menu key opens the menu from the keyboard", async () => {
    seed(rows, { sessions });
    renderList();
    screen.getByRole("option", { name: /r2\.md/ }).focus();
    await userEvent.keyboard("{ContextMenu}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("`p` toggles pin on the focused row; Enter opens it; bare Delete does nothing", async () => {
    seed(rows, { sessions });
    const onOpen = vi.fn();
    const { api } = renderList(makeApi(), { onOpen });
    const row = screen.getByRole("option", { name: /r2\.md/ });
    row.focus();
    await userEvent.keyboard("p");
    expect(api.pinArtifact).toHaveBeenCalledWith("r2", true);
    await userEvent.keyboard("{Delete}");
    expect(api.removeArtifact).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "r2" }));
  });

  it("arrow keys move between rows", async () => {
    seed(rows, { sessions });
    renderList();
    const first = screen.getByRole("option", { name: /pin\.md/ });
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("option", { name: /r2\.md/ })).toHaveFocus());
  });

  it("clicking a row calls onOpen with it", async () => {
    seed(rows, { sessions });
    const onOpen = vi.fn();
    renderList(makeApi(), { onOpen });
    await userEvent.click(screen.getByRole("option", { name: /r2\.md/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "r2" }));
  });
});

describe("ArtifactsList popovers close when the pane is hidden", () => {
  const observers: { cb: IntersectionObserverCallback; el: Element | null }[] = [];
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private entry: { cb: IntersectionObserverCallback; el: Element | null };
        constructor(cb: IntersectionObserverCallback) {
          this.entry = { cb, el: null };
          observers.push(this.entry);
        }
        observe(el: Element) {
          this.entry.el = el;
        }
        disconnect() {
          this.entry.el = null;
        }
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const hide = () =>
    act(() => {
      for (const o of observers.filter((x) => x.el)) {
        o.cb([{ isIntersecting: false, target: o.el } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    });

  it("the row menu closes", async () => {
    seed([makeRow({ id: "r2", writers: ["s-run"] })]);
    renderList();
    const wrap = screen.getByRole("option", { name: /r2\.md/ }).parentElement!;
    await userEvent.click(within(wrap).getByRole("button", { name: "Row actions" }));
    expect(screen.getByRole("menu", { name: "Artifact actions" })).toBeInTheDocument();
    hide();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the agent picker closes", async () => {
    seed([makeRow({ id: "r2", writers: ["s-run"] })]);
    renderList();
    await userEvent.click(screen.getByRole("button", { name: /^Filter by agent:/ }));
    expect(screen.getByRole("menu", { name: "Filter by agent" })).toBeInTheDocument();
    hide();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("ArtifactsList live-state rule (7.T8)", () => {
  it("resolves state via sessionStates[id] ?? session.state, never lifecycleState", () => {
    // `lifecycleState` is "drafting" (frozen) on every fixture session: if it were read, none would be live.
    const sessions = [
      session("only-map", { state: "exited", lifecycleState: "exited" }),
      session("only-record", { state: "working", lifecycleState: "exited" }),
      session("map-wins", { state: "working", lifecycleState: "working" }),
    ];
    seed(
      [
        makeRow({ id: "a", writers: ["only-map"], lastWrittenAt: "2026-10-27T10:03:00.000Z" }),
        makeRow({ id: "b", writers: ["only-record"], lastWrittenAt: "2026-10-27T10:02:00.000Z" }),
        makeRow({ id: "c", writers: ["map-wins"], lastWrittenAt: "2026-10-27T10:01:00.000Z" }),
      ],
      { sessions, states: { "only-map": "working", "map-wins": "done" } },
    );
    renderList();
    // a: record says exited but the live map says working -> This run; b: no map entry, record working -> This run;
    // c: map says done (wins over the record's working) -> Earlier.
    expect(names()).toEqual(["a.md", "b.md"]);
    expect(screen.getByRole("group", { name: "This run, 2 artifacts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Earlier, 1 artifact" })).toBeInTheDocument();
  });
});

describe("ArtifactsList re-render budget (R1F-15)", () => {
  it("patching one row re-renders at most two rows", () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeRow({ id: `r${i}`, writers: ["s-run"], lastWrittenAt: `2026-10-27T10:${String(i).padStart(2, "0")}:00.000Z` }));
    seed(rows);
    renderRowCounter.count = 0;
    renderList();
    expect(renderRowCounter.count).toBeGreaterThanOrEqual(50);
    renderRowCounter.count = 0;
    act(() => useArtifactsStore.getState().patchRow(S, { ...rows[3]!, editCount: 9 }));
    expect(renderRowCounter.count).toBeLessThanOrEqual(2);
  });
});

describe("artifactSessions and multi-writer rows (R2F-25)", () => {
  const mainSession = session("main", { name: "main", isMain: true, modeIcon: "claude", channel: "json" });
  const agent2 = session("agent-2", { name: "agent-2", modeIcon: "codex" });
  const subagent = session("sub-1", { name: "sub-1", parentSessionId: "main" });
  const sessions = [mainSession, agent2, subagent];
  const byId = new Map(sessions.map((s) => [s.id, s]));

  const rowMulti = makeRow({ id: "doc-multi", writers: ["main", "agent-2"] });
  const rowSub = makeRow({ id: "doc-sub", writers: ["sub-1", "agent-2"] });
  const rowSingle = makeRow({ id: "doc-single", writers: ["main"] });

  it("writerOf and otherWriterCount unit behavior", () => {
    expect(writerOf(rowMulti, byId)?.id).toBe("main");
    expect(writerOf(rowMulti, byId, "agent-2")?.id).toBe("agent-2");
    expect(writerOf(rowSub, byId, "main")?.id).toBe("sub-1");

    expect(otherWriterCount(rowMulti)).toBe(1);
    expect(otherWriterCount(rowSingle)).toBe(0);
    expect(otherWriterNames(rowMulti, byId, mainSession)).toBe("agent-2");
    expect(otherWriterNames(rowMulti, byId, agent2)).toBe("main");
  });

  it("a row with writers [main, agent-2] stays in both agents' filters; a single-writer row only in its own", async () => {
    seed([rowMulti, rowSingle], { sessions });
    renderList();
    const present = (id: string) => document.querySelector(`[data-artifact-id="${id}"]`) !== null;
    expect(present("doc-multi")).toBe(true);
    expect(present("doc-single")).toBe(true);

    // Writers are shown in Details (tools-pane-rework B6), so the filter's membership is what the list shows.
    const trigger = screen.getByRole("button", { name: /^Filter by agent:/ });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^agent-2,/ }));
    expect(present("doc-multi")).toBe(true);
    expect(present("doc-single")).toBe(false);
  });

  it("a subagent writer resolves to its parent's filter", async () => {
    seed([rowSub], { sessions });
    renderList();
    const trigger = screen.getByRole("button", { name: /^Filter by agent:/ });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^main,/ }));
    // rowSub matches because sub-1's rootSessionId is main.
    expect(document.querySelector('[data-artifact-id="doc-sub"]')).not.toBeNull();
  });
});

describe("ArtifactsList one-line rows and Details (tools-pane-rework B6.2-B6.3)", () => {
  it("same-named files show their nearest differing folder as a hint; unique names show none", () => {
    seed(
      [
        makeRow({ id: "r1", displayPath: "web-ui/README.md", path: "/repo/web-ui/README.md", writers: ["s-run"] }),
        makeRow({ id: "r2", displayPath: "rust/vst-git/README.md", path: "/repo/rust/vst-git/README.md", writers: ["s-run"] }),
        makeRow({ id: "u", displayPath: "docs/plan.md", writers: ["s-run"] }),
      ],
      { sessions: [session("s-run")] },
    );
    renderList();
    expect(document.querySelector('[data-artifact-id="r1"] .artifacts-row__hint')).toHaveTextContent("web-ui");
    expect(document.querySelector('[data-artifact-id="r2"] .artifacts-row__hint')).toHaveTextContent("vst-git");
    expect(document.querySelector('[data-artifact-id="u"] .artifacts-row__hint')).toBeNull();
  });

  it("the row menu's Details opens the Details store with the artifact row", async () => {
    const pinned = makeRow({ id: "pin", pinned: true, displayPath: "docs/pin.md", path: "/repo/docs/pin.md", writers: ["s-run"] });
    seed([pinned], { sessions: [session("s-run")] });
    renderList();
    const row = screen.getByRole("option", { name: /pin\.md/ });
    await userEvent.click(within(row.parentElement!).getByRole("button", { name: "Row actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Details" }));
    const target = useDetailsStore.getState().target;
    expect(target?.artifact?.id).toBe("pin");
    expect(target?.name).toBe("pin.md");
    expect(target?.path).toBe("/repo/docs/pin.md");
    useDetailsStore.setState({ target: null });
  });
});
