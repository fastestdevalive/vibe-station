import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewApiError } from "@/api/errors";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { openEscapeLayers } from "@/lib/escapeLayers";
import { toPlainText } from "@/lib/mentions";
import { useModesStore } from "@/store/modesStore";
import { ReviewPicker, type ReviewPickerProps } from "./ReviewPicker";
import { calls, makeApi, makeSession } from "./testHarness";
import { makeComment as c, makeDelivery } from "./testFixtures";
import { useCommentStore } from "./useCommentStore";

if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}
if (typeof Text !== "undefined" && !(Text.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect) {
  (Text.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}

const DRAFT = "vst-review-picker-draft:worktree:wt-1";
const comments = [c({ id: "a", pin: 1, path: "a.ts" }), c({ id: "b", pin: 2, path: "b.ts" })];

function sessions() {
  return [
    makeSession({ id: "idle", name: "main", state: "idle" }),
    makeSession({ id: "busy", name: "reviewer", isMain: false, state: "working" }),
    makeSession({ id: "gone", name: "old-session", isMain: false, state: "exited" }),
    makeSession({ id: "fin", name: "finished-task", isMain: false, state: "done" }),
    makeSession({ id: "term", name: "Agent 1", isMain: false, channel: "tmux", state: "idle" }),
    makeSession({ id: "term-wait", name: "Agent 2", isMain: false, channel: "tmux", state: "waiting_for_human" }),
    makeSession({ id: "pty", name: "Agent 4", isMain: false, channel: "pty", state: "idle" }),
    makeSession({ id: "nocli", name: "Agent 5", isMain: false, channel: "tmux", state: "idle", modeId: "m-plain" }),
    makeSession({ id: "nomode", name: "Agent 6", isMain: false, channel: "tmux", state: "idle", modeId: "m-deleted" }),
    makeSession({ id: "draft", name: null, isMain: false, state: "drafting", draftPrompt: "wip", channel: "json" }),
    makeSession({ id: "other-wt", name: "elsewhere", worktreeId: "wt-2", state: "idle" }),
    makeSession({ id: "archived", name: "archived", isMain: false, archivedAt: "2026-01-01T00:00:00Z" }),
  ];
}

const onClose = vi.fn();
const onDone = vi.fn();
const anchor = { current: null as HTMLElement | null };

function mount(api = makeApi(), over: Partial<ReviewPickerProps> = {}) {
  anchor.current = document.body.appendChild(document.createElement("button"));
  const utils = render(
    <ReviewPicker
      api={api}
      scope={{ scopeKind: "worktree", scopeId: "wt-1" }}
      comments={comments}
      anchorRef={anchor}
      onClose={onClose}
      onDone={onDone}
      {...over}
    />,
  );
  return { api, ...utils };
}

const rowOf = (name: string): HTMLElement => {
  const row = [...document.querySelectorAll<HTMLElement>("[role=radio]")].find((r) => within(r).queryByText(name));
  if (!row) throw new Error(`no picker row named ${name}`);
  return row;
};
const agents = () => screen.findByRole("radiogroup", { name: "Agent" });
/** The one primary button: "Send" or "Schedule" (aria-label "Send to <agent>" / "Schedule for <agent>"). */
const primary = () => document.querySelector<HTMLButtonElement>(".comment-picker__primary")!;
const chooseLater = () => fireEvent.click(screen.getByRole("radio", { name: "Later" }));
const selectedName = () => document.querySelector<HTMLElement>('[role=radio][aria-checked="true"][data-session-id]')?.querySelector(".comment-picker__name")?.textContent ?? null;

beforeEach(() => {
  localStorage.clear();
  onClose.mockReset();
  onDone.mockReset();
  useCommentStore.getState().reset();
  useCommentStore.getState().replace("wt-1", "worktree", { comments, nextPin: 3, terminalDeliveries: [] });
  useServerStore.setState({ sessions: sessions(), worktrees: [{ id: "wt-1", projectId: "p1", branch: "feat" }] } as never);
  useWorkspaceStore.setState({ sessionStates: {}, activeSessionId: null } as never);
  useModesStore.getState().setModes([
    { id: "m-claude", name: "Claude", cli: "claude", context: "" },
    { id: "m-plain", name: "Plain", cli: "plain", context: "" },
  ] as never);
});

afterEach(() => {
  anchor.current?.remove();
});

describe("ReviewPicker agent rows (6.T3)", () => {
  it("lists this worktree's live agents as radio rows with the eligibility copy and no buttons inside", async () => {
    mount();
    await agents();
    expect(screen.queryByText("elsewhere")).toBeNull();
    expect(screen.queryByText("archived")).toBeNull();
    expect(document.querySelectorAll(".comment-picker__clock")).toHaveLength(0);
    for (const row of document.querySelectorAll("[role=radio][data-session-id]")) expect(within(row as HTMLElement).queryByRole("button")).toBeNull();

    const main = rowOf("main");
    expect(within(main).getByText("main")).toHaveAttribute("title", "main");
    expect(within(main).getByText("Rich Chat")).toBeInTheDocument();
    expect(within(main).getByText("idle")).toBeInTheDocument();
    expect(main).not.toHaveAttribute("aria-disabled");

    expect(within(rowOf("reviewer")).getByText("working · queues")).toBeInTheDocument();
    expect(within(rowOf("old-session")).getByText("exited · resumes on send")).toBeInTheDocument();
    expect(within(rowOf("finished-task")).getByText("marked done · sends with warning")).toBeInTheDocument();
    expect(rowOf("finished-task")).not.toHaveAttribute("aria-disabled");

    const draft = rowOf("wip");
    expect(within(draft).getByText("Draft")).toBeInTheDocument();
    expect(draft).toHaveAttribute("aria-disabled", "true");
  });

  it("Terminal rows: ready / awaiting approval / pty / unsupported CLI / missing mode", async () => {
    const api = makeApi({ terminalReadiness: vi.fn().mockImplementation((id: string) => Promise.resolve(id === "term" ? "ready" : "unknown")) });
    mount(api);
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    const t = rowOf("Agent 1");
    expect(within(t).getByText("Terminal")).toBeInTheDocument();
    expect(t).not.toHaveAttribute("aria-disabled");
    expect(api.terminalReadiness).toHaveBeenCalledWith("term");
    expect(api.terminalReadiness).not.toHaveBeenCalledWith("pty");

    await waitFor(() => expect(within(rowOf("Agent 2")).getByText("awaiting approval / unknown")).toBeInTheDocument());
    expect(rowOf("Agent 2")).toHaveAttribute("aria-disabled", "true");
    expect(within(rowOf("Agent 4")).getByText("Terminal (pty)")).toBeInTheDocument();
    expect(within(rowOf("Agent 4")).getByText("not supported")).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf("Agent 5")).getByText("not supported")).toBeInTheDocument());
    expect(within(rowOf("Agent 6")).getByText("mode no longer exists")).toBeInTheDocument();
  });

  it("an awaiting-approval probe disables an otherwise idle Terminal row", async () => {
    mount(makeApi({ terminalReadiness: vi.fn().mockResolvedValue("awaiting_approval") }));
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("awaiting approval")).toBeInTheDocument());
    expect(rowOf("Agent 1")).toHaveAttribute("aria-disabled", "true");
  });

  it("resolves state through the live map first (sessionStates ?? state), never lifecycleState", async () => {
    useWorkspaceStore.setState({ sessionStates: { idle: "working" } } as never);
    mount();
    await agents();
    expect(within(rowOf("main")).getByText("working · queues")).toBeInTheDocument();
  });

  it("a disabled row cannot be selected by click", async () => {
    mount();
    await agents();
    fireEvent.click(rowOf("Agent 2"));
    fireEvent.click(rowOf("wip"));
    expect(rowOf("wip")).toHaveAttribute("aria-checked", "false");
    expect(rowOf("Agent 2")).toHaveAttribute("aria-checked", "false");
    expect(selectedName()).toBe("main");
  });
});

describe("ReviewPicker default selection: the focused agent (R61)", () => {
  it("preselects the agent focused in the agent pane", async () => {
    useWorkspaceStore.setState({ activeSessionId: "busy" } as never);
    mount();
    await agents();
    expect(rowOf("reviewer")).toHaveAttribute("aria-checked", "true");
    expect(rowOf("main")).toHaveAttribute("aria-checked", "false");
    expect(primary()).toHaveAttribute("aria-label", "Send to reviewer");
  });

  it("changing the focused agent before opening changes the default", async () => {
    useWorkspaceStore.setState({ activeSessionId: "idle" } as never);
    const first = mount();
    await agents();
    expect(selectedName()).toBe("main");
    first.unmount();
    useWorkspaceStore.setState({ activeSessionId: "fin" } as never);
    mount();
    await agents();
    expect(selectedName()).toBe("finished-task");
  });

  it("falls back to the first eligible agent when the focus is ineligible, in another worktree, or absent", async () => {
    // a Terminal agent awaiting approval is disabled
    useWorkspaceStore.setState({ activeSessionId: "term-wait" } as never);
    const a = mount();
    await agents();
    await waitFor(() => expect(selectedName()).toBe("main"));
    a.unmount();
    useWorkspaceStore.setState({ activeSessionId: "other-wt" } as never);
    const b = mount();
    await agents();
    expect(selectedName()).toBe("main");
    b.unmount();
    useWorkspaceStore.setState({ activeSessionId: null } as never);
    mount();
    await agents();
    expect(selectedName()).toBe("main");
  });

  it("project scope selects among the project's direct sessions", async () => {
    useServerStore.setState({
      sessions: [
        makeSession({ id: "d1", name: "direct-1", worktreeId: undefined as never, projectId: "p1", isMain: false, state: "idle" }),
        makeSession({ id: "d2", name: "direct-2", worktreeId: undefined as never, projectId: "p1", isMain: false, state: "idle" }),
        makeSession({ id: "wtmain", name: "in-worktree", state: "idle" }),
      ],
    } as never);
    useWorkspaceStore.setState({ activeSessionId: "d2" } as never);
    mount(makeApi(), { scope: { scopeKind: "project", scopeId: "p1" } });
    await agents();
    expect(selectedName()).toBe("direct-2");
    expect(screen.queryByText("in-worktree")).toBeNull();
  });

  it("waits while the focused Terminal agent is still checking support, then selects it", async () => {
    useWorkspaceStore.setState({ activeSessionId: "term" } as never);
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const api = makeApi({
      getSupportedClis: vi.fn().mockReturnValue(gate),
      terminalReadiness: vi.fn().mockResolvedValue("ready"),
    });
    mount(api);
    await agents();
    expect(within(rowOf("Agent 1")).getByText("checking support…")).toBeInTheDocument();
    // not the first eligible agent while the focused one is settling
    expect(selectedName()).toBeNull();
    expect(primary()).toBeDisabled();
    expect(screen.getByText("Checking agent support…")).toBeInTheDocument();
    await act(async () => {
      release([{ id: "claude", supportsTerminalComments: true }]);
    });
    await waitFor(() => expect(selectedName()).toBe("Agent 1"));
    await waitFor(() => expect(primary()).toBeEnabled());
  });

  it("a focused idle Terminal agent (waiting_for_human) is selected once the probe says ready, and waits for it", async () => {
    useWorkspaceStore.setState({ activeSessionId: "term-wait" } as never);
    let release: (v: "ready") => void = () => {};
    const gate = new Promise<"ready">((r) => {
      release = r;
    });
    mount(makeApi({ terminalReadiness: vi.fn().mockReturnValue(gate) }));
    await agents();
    expect(within(rowOf("Agent 2")).getByText("checking…")).toBeInTheDocument();
    expect(selectedName()).toBeNull();
    expect(primary()).toBeDisabled();
    expect(screen.getByText("Checking agent support…")).toBeInTheDocument();
    await act(async () => {
      release("ready");
    });
    await waitFor(() => expect(rowOf("Agent 2")).toHaveAttribute("aria-checked", "true"));
    expect(within(rowOf("Agent 2")).getByText("ready")).toBeInTheDocument();
  });

  it("a waiting_for_human Terminal agent whose probe says awaiting_approval stays disabled and the first Rich Chat row is selected", async () => {
    useWorkspaceStore.setState({ activeSessionId: "term-wait" } as never);
    mount(makeApi({ terminalReadiness: vi.fn().mockResolvedValue("awaiting_approval") }));
    await waitFor(() => expect(within(rowOf("Agent 2")).getByText("awaiting approval")).toBeInTheDocument());
    expect(rowOf("Agent 2")).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(selectedName()).toBe("main"));
  });

  it("choosing Later scrolls THIS picker's When control into view once, clearing the bar's measured height + 16px (R2R-02)", async () => {
    const scroll = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("comment-picker__bar") ? 131 : 0;
    });
    // Another picker-like element elsewhere in the document must never be the scroll target.
    const decoy = document.body.appendChild(document.createElement("div"));
    decoy.className = "comment-picker__when";
    try {
      mount();
      await agents();
      chooseLater();
      const when = document.querySelector<HTMLElement>(".comment-picker .comment-picker__when");
      expect(scroll.mock.contexts.filter((el) => el === when)).toHaveLength(1);
      expect(scroll.mock.contexts).not.toContain(decoy);
      expect(when!.style.scrollMarginBottom).toBe("147px");
    } finally {
      decoy.remove();
      height.mockRestore();
      raf.mockRestore();
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("a user's choice survives a later focus change and the agent becoming ineligible (primary disables with the reason)", async () => {
    useWorkspaceStore.setState({ activeSessionId: "idle" } as never);
    mount();
    await agents();
    fireEvent.click(rowOf("reviewer"));
    expect(selectedName()).toBe("reviewer");
    act(() => useWorkspaceStore.setState({ activeSessionId: "fin" } as never));
    expect(selectedName()).toBe("reviewer");
    // the chosen agent exits: it stays selected, Send is disabled and says why
    act(() => useWorkspaceStore.setState({ sessionStates: { busy: "drafting" } } as never));
    expect(document.querySelector<HTMLElement>('[role=radio][aria-checked="true"]')?.dataset.sessionId).toBe("busy");
    expect(primary()).toBeDisabled();
    expect(primary().title).toMatch(/drafting · not started$/);
  });

  it("before the user touches the list, a default that became ineligible re-resolves to the first eligible agent", async () => {
    useWorkspaceStore.setState({ activeSessionId: "busy" } as never);
    mount();
    await agents();
    expect(selectedName()).toBe("reviewer");
    act(() => useWorkspaceStore.setState({ sessionStates: { busy: "drafting" } } as never));
    expect(selectedName()).toBe("main");
  });

  it("no eligible agent: nothing is selected and the primary says why", async () => {
    useServerStore.setState({ sessions: [makeSession({ id: "d", name: null, state: "drafting", draftPrompt: "x" })] } as never);
    mount();
    await agents();
    expect(selectedName()).toBeNull();
    expect(primary()).toBeDisabled();
    expect(primary()).toHaveAttribute("title", "No agent here can take comments.");
  });
});

describe("ReviewPicker keyboard", () => {
  it("arrows move the selection over enabled rows only, wrap, and Home/End jump", async () => {
    useWorkspaceStore.setState({ activeSessionId: "idle" } as never);
    mount(makeApi({ terminalReadiness: vi.fn().mockImplementation((id: string) => Promise.resolve(id === "term" ? "ready" : "unknown")) }));
    await agents();
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    const list = screen.getByRole("radiogroup", { name: "Agent" });
    // enabled order: main, reviewer, old-session, finished-task, Agent 1 (draft, Agent 2/4/5/6 are skipped)
    rowOf("main").focus();
    fireEvent.keyDown(rowOf("main"), { key: "ArrowDown" });
    expect(selectedName()).toBe("reviewer");
    fireEvent.keyDown(list, { key: "End" });
    expect(selectedName()).toBe("Agent 1");
    fireEvent.keyDown(rowOf("Agent 1"), { key: "ArrowDown" });
    expect(selectedName()).toBe("main"); // wrapped, skipping every disabled row
    fireEvent.keyDown(rowOf("main"), { key: "ArrowUp" });
    expect(selectedName()).toBe("Agent 1");
    fireEvent.keyDown(list, { key: "Home" });
    expect(selectedName()).toBe("main");
    expect(document.activeElement).toBe(rowOf("main"));
  });

  it("the selected row is the only tab stop", async () => {
    useWorkspaceStore.setState({ activeSessionId: "busy" } as never);
    mount();
    await agents();
    const stops = [...document.querySelectorAll<HTMLElement>("[role=radio][data-session-id]")].filter((r) => r.tabIndex === 0);
    expect(stops.map((r) => r.dataset.sessionId)).toEqual(["busy"]);
  });

  it("Enter on the agent list runs the primary", async () => {
    const { api } = mount();
    await agents();
    fireEvent.keyDown(rowOf("main"), { key: "Enter" });
    await waitFor(() => expect(api.sendChat).toHaveBeenCalledTimes(1));
  });

  it("Cmd/Ctrl+Enter in the message field runs the primary; plain Enter does not", async () => {
    const { api } = mount();
    const field = await screen.findByLabelText("Message for the agent");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(api.sendChat).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sendChat).toHaveBeenCalledTimes(1));
  });

  it("Enter in the date and time input runs Schedule", async () => {
    const { api } = mount();
    await agents();
    chooseLater();
    fireEvent.keyDown(screen.getByLabelText("Send at"), { key: "Enter" });
    await waitFor(() => expect(api.scheduleMessage).toHaveBeenCalledTimes(1));
  });
});

describe("ReviewPicker primary Send / Schedule (R61, R65, R66)", () => {
  it("one primary button: label Send or Schedule, aria-label names the selected agent, no per-row buttons", async () => {
    mount();
    await agents();
    expect(primary()).toHaveTextContent(/^Send$/);
    expect(primary()).toHaveAttribute("aria-label", "Send to main");
    expect(document.querySelectorAll(".comment-picker__primary")).toHaveLength(1);
    chooseLater();
    expect(primary()).toHaveTextContent(/^Schedule$/);
    expect(primary()).toHaveAttribute("aria-label", "Schedule for main");
    fireEvent.click(rowOf("reviewer"));
    expect(primary()).toHaveAttribute("aria-label", "Schedule for reviewer");
  });

  it("initialWhen=later opens with Later selected and the date and time in the same dialog", async () => {
    mount(makeApi(), { initialWhen: "later" });
    await agents();
    expect(screen.getByRole("radio", { name: "Later" })).toHaveAttribute("aria-checked", "true");
    const dlg = screen.getByRole("dialog", { name: "Send 2 comments" });
    expect(within(dlg).getByLabelText("Send at")).toBeInTheDocument();
    expect(primary()).toHaveTextContent("Schedule");
    // the time zone and the resolved time are shown, and the input carries a min
    expect(within(dlg).getByText(/^Fires .*\(.+\)$/)).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Send at")).toHaveAttribute("min");
  });

  it("the Later input's min is the first acceptable minute and follows the clock (R1R-03)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(new Date(2030, 0, 1, 10, 0, 30));
      mount();
      await agents();
      chooseLater();
      const input = screen.getByLabelText("Send at") as HTMLInputElement;
      expect(input.min).toBe("2030-01-01T10:01");
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect((screen.getByLabelText("Send at") as HTMLInputElement).min).toBe("2030-01-01T10:02");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Now is the default for the plain Send open: no date input until Later", async () => {
    mount();
    await agents();
    expect(screen.getByRole("radio", { name: "Now" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByLabelText("Send at")).toBeNull();
  });

  it("Rich Chat + Now: sendChat with the ids, queue:true and an EMPTY message allowed; rows leave the panel", async () => {
    const { api } = mount();
    await agents();
    fireEvent.click(primary());
    await waitFor(() => expect(api.sendChat).toHaveBeenCalledTimes(1));
    expect(api.sendChat).toHaveBeenCalledWith("idle", "", undefined, true, undefined, ["a", "b"]);
    expect(api.scheduleMessage).not.toHaveBeenCalled();
    expect(useCommentStore.getState().byScope["wt-1"]!.comments).toHaveLength(0);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("Rich Chat + Now converts the message with toWire and clears the draft", async () => {
    localStorage.setItem(DRAFT, "Please fix a{b}");
    const { api } = mount();
    await agents();
    fireEvent.click(primary());
    await waitFor(() => expect(api.sendChat).toHaveBeenCalled());
    expect(calls(api.sendChat)[0]![1]).toBe("Please fix a\\{b}");
    await waitFor(() => expect(localStorage.getItem(DRAFT)).toBeNull());
  });

  it("Terminal + Now: createTerminalDelivery with the plain-text message (renderDraftText) and the delivery in the store", async () => {
    localStorage.setItem(DRAFT, "go a{b}");
    const create = vi.fn().mockResolvedValue({ delivery: makeDelivery({ id: "dx", sessionId: "term", state: "waiting" }) });
    const { api } = mount(makeApi({ createTerminalDelivery: create, terminalReadiness: vi.fn().mockResolvedValue("ready") }));
    await agents();
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    fireEvent.click(primary());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toBe("wt-1");
    expect(create.mock.calls[0]![2]).toMatchObject({ sessionId: "term", commentIds: ["a", "b"], message: "go a{b}" });
    expect(create.mock.calls[0]![2].terminalDeliveryId).toBeTruthy();
    expect(api.sendChat).not.toHaveBeenCalled();
    expect(useCommentStore.getState().byScope["wt-1"]!.deliveries.dx).toBeDefined();
    expect(useCommentStore.getState().byScope["wt-1"]!.comments).toHaveLength(0);
  });

  it("Rich Chat + Later: scheduleMessage with the sidecar-less wire message (escaped braces), no attachments, the comment ids and a future ISO time", async () => {
    localStorage.setItem(DRAFT, "later a{b}");
    const { api } = mount();
    await agents();
    chooseLater();
    fireEvent.click(primary());
    await waitFor(() => expect(api.scheduleMessage).toHaveBeenCalledTimes(1));
    const [sid, message, fireAt, atts, ids] = calls(api.scheduleMessage)[0]!;
    expect([sid, message, atts, ids]).toEqual(["idle", "later a\\{b}", undefined, ["a", "b"]]);
    expect(new Date(fireAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(api.sendChat).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(useCommentStore.getState().byScope["wt-1"]!.comments).toHaveLength(0);
    expect(localStorage.getItem(DRAFT)).toBeNull();
  });

  it("W2-02 — Rich Chat + Later keeps a /skill token in the wire form; Terminal + Later sends the plain rendering", async () => {
    localStorage.setItem(DRAFT, "{/review-pr focus on auth} then a{b}");
    const { api } = mount(makeApi({ terminalReadiness: vi.fn().mockResolvedValue("ready") }));
    await agents();
    chooseLater();
    fireEvent.click(primary());
    await waitFor(() => expect(api.scheduleMessage).toHaveBeenCalledTimes(1));
    expect(calls(api.scheduleMessage)[0]![1]).toBe(toPlainText("{/review-pr focus on auth} then a{b}"));
    expect(calls(api.scheduleMessage)[0]![1]).toBe("{/review-pr focus on auth} then a\\{b}");
  });

  it("W2-02 — Terminal + Later with the same draft sends renderDraftText", async () => {
    localStorage.setItem(DRAFT, "go a{b}");
    const { api } = mount(makeApi({ terminalReadiness: vi.fn().mockResolvedValue("ready") }));
    await agents();
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    chooseLater();
    fireEvent.click(primary());
    await waitFor(() => expect(api.scheduleMessage).toHaveBeenCalledTimes(1));
    expect(calls(api.scheduleMessage)[0]![1]).toBe("go a{b}");
  });

  it("Terminal + Later: the same scheduleMessage call (the daemon turns it into a delivery at fire time)", async () => {
    const { api } = mount(makeApi({ terminalReadiness: vi.fn().mockResolvedValue("ready") }));
    await agents();
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    chooseLater();
    fireEvent.click(primary());
    await waitFor(() => expect(api.scheduleMessage).toHaveBeenCalledTimes(1));
    const [sid, message, , atts, ids] = calls(api.scheduleMessage)[0]!;
    expect([sid, message, atts, ids]).toEqual(["term", "", undefined, ["a", "b"]]);
    expect(api.createTerminalDelivery).not.toHaveBeenCalled();
  });

  it("Later with an empty time: inline error, primary disabled", async () => {
    mount();
    await agents();
    chooseLater();
    fireEvent.change(screen.getByLabelText("Send at"), { target: { value: "" } });
    expect(screen.getAllByText("Pick a date and time.").length).toBeGreaterThan(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a date and time.");
    expect(primary()).toBeDisabled();
  });

  it("Later with a past time: inline error and a disabled primary; fixing it enables Schedule", async () => {
    const { api } = mount();
    await agents();
    chooseLater();
    const input = screen.getByLabelText("Send at");
    fireEvent.change(input, { target: { value: "2000-01-01T00:00" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a time in the future.");
    expect(primary()).toBeDisabled();
    expect(primary()).toHaveAttribute("title", "Pick a time in the future.");
    fireEvent.click(primary());
    expect(api.scheduleMessage).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "2099-01-01T10:00" } });
    expect(primary()).toBeEnabled();
  });

  it("time passing while the popup is open: valid at open, past at click gives the inline error and no call", async () => {
    const { api } = mount();
    await agents();
    chooseLater();
    expect(primary()).toBeEnabled();
    const real = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(real + 24 * 3_600_000);
    try {
      fireEvent.click(primary());
      expect(await screen.findByRole("alert")).toHaveTextContent("Pick a time in the future.");
      expect(api.scheduleMessage).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("while a request is in flight the label reads Sending… / Scheduling… and the button is disabled", async () => {
    let release: (v: unknown) => void = () => {};
    const send = vi.fn().mockReturnValue(new Promise((r) => (release = r)));
    mount(makeApi({ sendChat: send }));
    await agents();
    fireEvent.click(primary());
    await waitFor(() => expect(primary()).toHaveTextContent("Sending…"));
    expect(primary()).toBeDisabled();
    await act(async () => release({ turnId: "t", queuePosition: 1 }));
  });

  it("a 409 comments_changed keeps the picker open, says what changed and refetches", async () => {
    const send = vi.fn().mockRejectedValue(new ReviewApiError("x", 409, "comments_changed", { remaining: 1 }));
    const { api } = mount(makeApi({ sendChat: send }));
    await agents();
    fireEvent.click(primary());
    expect(await screen.findByRole("alert")).toHaveTextContent("1 comment changed, review and send again");
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(api.listComments).toHaveBeenCalled());
  });

  it("a 409 delivery_in_flight keeps the popup open and says so", async () => {
    const create = vi.fn().mockRejectedValue(new ReviewApiError("x", 409, "delivery_in_flight", {}));
    mount(makeApi({ createTerminalDelivery: create, terminalReadiness: vi.fn().mockResolvedValue("ready") }));
    await agents();
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    fireEvent.click(primary());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A send to this agent is already in progress");
    // R2R-01: the request error lives in the sticky bar, directly above its buttons, so a phone never hides it.
    expect(alert.closest(".comment-picker__bar")).not.toBeNull();
    expect(alert.nextElementSibling).toBe(document.querySelector(".comment-picker__bar-row"));
    expect(onClose).not.toHaveBeenCalled();
    expect(localStorage.getItem(DRAFT)).toBeNull(); // nothing typed; the draft is only cleared on success
  });

  it("over the Rich Chat limit: the primary is disabled with the hint for a Rich agent, enabled for a Terminal agent; Copy as text still works (R66)", async () => {
    const many = Array.from({ length: 201 }, (_, i) => c({ id: `m${i}`, pin: i + 1, blockBytes: 50 }));
    const { api } = mount(makeApi({ terminalReadiness: vi.fn().mockResolvedValue("ready") }), { comments: many });
    await agents();
    expect(primary()).toBeDisabled();
    expect(primary()).toHaveAttribute("title", "Send fewer or copy as text");
    expect(screen.getByRole("button", { name: "Attach to agent" })).toBeDisabled();
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    expect(primary()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Copy as text/ }));
    await waitFor(() => expect(api.renderComments).toHaveBeenCalledTimes(1));
  });

  it("a Terminal send over 32 KB is blocked (Now and Later) while Rich Chat still goes", async () => {
    const big = Array.from({ length: 40 }, (_, i) => c({ id: `m${i}`, pin: i + 1, blockBytes: 1000 }));
    mount(makeApi({ terminalReadiness: vi.fn().mockResolvedValue("ready") }), { comments: big });
    await agents();
    expect(primary()).toBeEnabled();
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    expect(primary()).toBeDisabled();
    expect(primary()).toHaveAttribute("title", "Send fewer or copy as text");
    chooseLater();
    expect(primary()).toBeDisabled();
  });

  it("offline: the primary, Attach and Copy are disabled with the reason; the draft is kept", async () => {
    localStorage.setItem(DRAFT, "keep");
    mount(makeApi({ getConnectionState: () => "offline" }));
    await agents();
    expect(primary()).toBeDisabled();
    expect(primary()).toHaveAttribute("title", "Offline · reconnecting");
    expect(screen.getByRole("button", { name: "Attach to agent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Copy as text/ })).toBeDisabled();
    expect(localStorage.getItem(DRAFT)).toBe("keep");
  });
});

describe("ReviewPicker warnings (6.T5): for the selected agent only", () => {
  const TYPED = "Terminal: text already typed at the agent’s prompt is submitted together with the comments.";
  const ready = () => makeApi({ terminalReadiness: vi.fn().mockResolvedValue("ready") });

  it("the typed-text warning shows only when a Terminal agent is selected", async () => {
    mount(ready());
    await agents();
    expect(screen.queryByText(TYPED)).toBeNull();
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    expect(screen.getByText(TYPED)).toBeInTheDocument();
    fireEvent.click(rowOf("main"));
    expect(screen.queryByText(TYPED)).toBeNull();
  });

  it("a /skill message warns only with a Terminal agent selected", async () => {
    localStorage.setItem(DRAFT, "/review src/auth");
    mount(ready());
    await agents();
    expect(screen.queryByText("This agent receives the comments as part of the /skill command.")).toBeNull();
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    expect(screen.getByText("This agent receives the comments as part of the /skill command.")).toBeInTheDocument();
  });

  describe("placement by viewport (R2R-02)", () => {
    const setMobile = (on: boolean) => {
      window.matchMedia = ((q: string) => ({
        matches: on,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      })) as never;
    };
    const original = window.matchMedia;
    afterEach(() => {
      window.matchMedia = original;
    });

    it("phones: both warnings sit inside the sticky bar, above its buttons", async () => {
      setMobile(true);
      localStorage.setItem(DRAFT, "/review src/auth");
      mount(ready());
      await agents();
      await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
      fireEvent.click(rowOf("Agent 1"));
      const bar = document.querySelector(".comment-picker__bar")!;
      expect(within(bar as HTMLElement).getByText(TYPED)).toBeInTheDocument();
      expect(within(bar as HTMLElement).getByText("This agent receives the comments as part of the /skill command.")).toBeInTheDocument();
      expect(bar.querySelector(".comment-picker__warn")!.compareDocumentPosition(bar.querySelector(".comment-picker__bar-row")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.querySelectorAll(`.comment-picker__body > .comment-picker__warn`)).toHaveLength(0);
    });

    it("P-04 — phones: focusing the Message field sets its scroll margin to the bar's height + 8px and scrolls it into view", async () => {
      setMobile(true);
      const scroll = vi.fn();
      const orig = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scroll;
      const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("comment-picker__bar") ? 140 : 0;
      });
      try {
        mount(ready());
        await agents();
        await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
        fireEvent.click(rowOf("Agent 1"));
        const field = document.querySelector<HTMLElement>(".comment-picker__field")!;
        scroll.mockClear();
        fireEvent.focus(field.querySelector("[contenteditable], .comment-picker__editor") ?? field);
        expect(field.style.scrollMarginBottom).toBe("148px");
        expect(scroll.mock.contexts).toContain(field);
      } finally {
        height.mockRestore();
        Element.prototype.scrollIntoView = orig;
      }
    });

    it("phones: a Rich Chat row has no warning in the bar", async () => {
      setMobile(true);
      mount(ready());
      await agents();
      fireEvent.click(rowOf("main"));
      expect(document.querySelector(".comment-picker__bar .comment-picker__warn")).toBeNull();
    });

    it("desktop: the warning stays in the body, after the When block and outside the bar", async () => {
      setMobile(false);
      mount(ready());
      await agents();
      await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
      fireEvent.click(rowOf("Agent 1"));
      const warn = screen.getByText(TYPED);
      expect(warn.closest(".comment-picker__bar")).toBeNull();
      expect(document.querySelector(".comment-picker__when")!.compareDocumentPosition(warn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it("P-05 — the 'Use Attach to agent' hint shows only when the Attach button is available (Rich Chat + Now)", async () => {
    mount(ready());
    await agents();
    const meta = () => document.querySelector(".comment-picker__meta")!;
    expect(screen.getByRole("button", { name: "Attach to agent" })).toBeInTheDocument();
    expect(meta().textContent).toContain("Use Attach to agent");
    chooseLater();
    expect(screen.queryByRole("button", { name: "Attach to agent" })).toBeNull();
    expect(meta().textContent).not.toContain("Attach");
    fireEvent.click(screen.getByRole("radio", { name: "Now" }));
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    expect(screen.queryByRole("button", { name: "Attach to agent" })).toBeNull();
    expect(meta().textContent).not.toContain("Attach");
  });

  it("a plain message does not", async () => {
    localStorage.setItem(DRAFT, "just words");
    mount(ready());
    await agents();
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    expect(screen.queryByText(/part of the \/skill command/)).toBeNull();
  });
});

describe("ReviewPicker Attach to agent (6.T3b)", () => {
  it("attaches the checked ids to the selected Rich Chat agent, switches to its tab, hands over the message and sends nothing", async () => {
    localStorage.setItem(DRAFT, "Run the tests");
    const { api } = mount();
    await agents();
    fireEvent.click(rowOf("reviewer"));
    fireEvent.click(screen.getByRole("button", { name: "Attach to agent" }));
    await waitFor(() => expect(api.attachComments).toHaveBeenCalledWith("wt-1", "worktree", { composerKey: "session:busy", commentIds: ["a", "b"] }));
    await waitFor(() => expect(useWorkspaceStore.getState().activeSessionId).toBe("busy"));
    expect(localStorage.getItem("vst-chat-draft-busy")).toBe("Run the tests");
    expect(localStorage.getItem(DRAFT)).toBeNull();
    expect(api.sendChat).not.toHaveBeenCalled();
    expect(useCommentStore.getState().byScope["wt-1"]!.comments.every((x) => x.attachedTo === "session:busy")).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it("appends the message on a new line when that composer already has text", async () => {
    localStorage.setItem(DRAFT, "second");
    localStorage.setItem("vst-chat-draft-busy", "first");
    mount();
    await agents();
    fireEvent.click(rowOf("reviewer"));
    fireEvent.click(screen.getByRole("button", { name: "Attach to agent" }));
    await waitFor(() => expect(localStorage.getItem("vst-chat-draft-busy")).toBe("first\nsecond"));
  });

  it("appears only for a Rich Chat agent with When = Now", async () => {
    mount(makeApi({ terminalReadiness: vi.fn().mockResolvedValue("ready") }));
    await agents();
    expect(screen.getByRole("button", { name: "Attach to agent" })).toBeInTheDocument();
    chooseLater();
    expect(screen.queryByRole("button", { name: "Attach to agent" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Now" }));
    await waitFor(() => expect(within(rowOf("Agent 1")).getByText("ready")).toBeInTheDocument());
    fireEvent.click(rowOf("Agent 1"));
    expect(screen.queryByRole("button", { name: "Attach to agent" })).toBeNull();
  });
});

describe("ReviewPicker New agent and Copy", () => {
  it("New agent creates a Tier-1 tab draft in the worktree, attaches the comments, seeds the prompt, opens it", async () => {
    localStorage.setItem(DRAFT, "Build it");
    const created = makeSession({ id: "newdraft", name: null, isMain: false, state: "drafting", draftConfig: { entryPoint: "tab" } as never });
    const api = makeApi({ createDraftSession: vi.fn().mockResolvedValue(created) });
    mount(api);
    fireEvent.click(await screen.findByRole("button", { name: /New agent with these comments/ }));
    await waitFor(() => expect(api.updateDraft).toHaveBeenCalled());
    expect(api.createDraftSession).toHaveBeenCalledWith({ target: "worktree", worktreeId: "wt-1", type: "agent", draftConfig: { entryPoint: "tab" } });
    expect(api.attachComments).toHaveBeenCalledWith("wt-1", "worktree", { composerKey: "session:newdraft", commentIds: ["a", "b"] });
    expect(api.updateDraft).toHaveBeenCalledWith("newdraft", { draftPrompt: "Build it", draftConfig: { entryPoint: "tab" } });
    expect(useWorkspaceStore.getState().activeSessionId).toBe("newdraft");
  });

  it("New agent is offered only with When = Now; Copy as text always", async () => {
    mount();
    await agents();
    expect(screen.getByRole("button", { name: /New agent with these comments/ })).toBeInTheDocument();
    chooseLater();
    expect(screen.queryByRole("button", { name: /New agent/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Copy as text/ })).toBeEnabled();
  });

  it("Copy as text renders through the daemon (message first) and writes the clipboard", async () => {
    localStorage.setItem(DRAFT, "Hello");
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    const { api } = mount();
    fireEvent.click(await screen.findByRole("button", { name: /Copy as text/ }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("RENDERED"));
    expect(api.renderComments).toHaveBeenCalledWith("wt-1", "worktree", { commentIds: ["a", "b"], message: "Hello" });
    expect(api.sendChat).not.toHaveBeenCalled();
    expect(useCommentStore.getState().byScope["wt-1"]!.comments).toHaveLength(2);
  });
});

describe("ReviewPicker placement (R1F-04)", () => {
  it("re-places against the opener when the popover height grows", async () => {
    let roCb: (() => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          roCb = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const innerHeight = vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
    let h = 100;
    const offset = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("comment-picker") ? h : 0;
    });
    try {
      anchor.current = document.body.appendChild(document.createElement("button"));
      anchor.current.getBoundingClientRect = () => ({ top: 835, bottom: 867, left: 1290, right: 1395, width: 105, height: 32, x: 1290, y: 835, toJSON() {} }) as DOMRect;
      render(<ReviewPicker api={makeApi()} scope={{ scopeKind: "worktree", scopeId: "wt-1" }} comments={comments} anchorRef={anchor} onClose={onClose} onDone={onDone} />);
      const dlg = await screen.findByRole("dialog");
      h = 515;
      await act(async () => {
        roCb?.();
      });
      expect(dlg.style.top).toBe("314px");
    } finally {
      offset.mockRestore();
      innerHeight.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("ReviewPicker a11y and layers (7.T2)", () => {
  it("is a named dialog with a Message field, a labelled agent list and registers on the escape stack", async () => {
    mount();
    const dlg = screen.getByRole("dialog", { name: "Send 2 comments" });
    expect(within(dlg).getByLabelText("Message for the agent")).toBeInTheDocument();
    expect(within(dlg).getByRole("radiogroup", { name: "Agent" })).toBeInTheDocument();
    expect(within(dlg).getByRole("radiogroup", { name: "When" })).toBeInTheDocument();
    expect(openEscapeLayers()).toContain("picker");
  });

  it("Esc inside the picker closes it", async () => {
    mount();
    const dlg = await screen.findByRole("dialog", { name: "Send 2 comments" });
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("an outside press closes it; a press on the opener does not", async () => {
    mount();
    await screen.findByRole("dialog");
    fireEvent.mouseDown(anchor.current!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("Tab wraps inside the picker (focus trap)", async () => {
    mount();
    const dlg = await screen.findByRole("dialog");
    const focusables = [...dlg.querySelectorAll<HTMLElement>("button:not([disabled])")];
    const last = focusables[focusables.length - 1]!;
    last.focus();
    await act(async () => {
      fireEvent.keyDown(last, { key: "Tab" });
    });
    expect(dlg.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
  });
});
