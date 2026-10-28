import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { CommentsTray } from "./CommentsTray";
import { makeApi, makeSession } from "./testHarness";
import { makeComment as c, makeDelivery } from "./testFixtures";
import { useCommentStore } from "./useCommentStore";
import { dismissTop, openEscapeLayers } from "@/lib/escapeLayers";

const kb = vi.hoisted(() => ({ visible: false }));
vi.mock("@/hooks/useVirtualKeyboardVisible", () => ({ useVirtualKeyboardVisible: () => kb.visible }));

const agent1 = { sessionId: "s2" } as const;
const seed = (comments = [c()], deliveries: ReturnType<typeof makeDelivery>[] = []) =>
  act(() => useCommentStore.getState().replace("wt-1", "worktree", { comments, nextPin: 20, terminalDeliveries: deliveries }));

const mount = (api = makeApi()) => render(<CommentsTray api={api} scopeId="wt-1" scopeKind="worktree" />);

beforeEach(() => {
  kb.visible = false;
  localStorage.clear();
  useCommentStore.getState().reset();
  useServerStore.setState({
    sessions: [makeSession({ id: "s1", name: "main" }), makeSession({ id: "s2", name: "Agent 1", isMain: false, channel: "tmux" })],
    worktrees: [],
  } as never);
});

describe("CommentsTray (6.T1)", () => {
  it("renders nothing when there are no comments", () => {
    seed([]);
    const { container } = mount();
    expect(container.querySelector(".comment-tray")).toBeNull();
  });

  it("pluralises the count and shows per-file chips with +N more", () => {
    seed([c({ id: "1", pin: 1, path: "a/One.ts" })]);
    mount();
    expect(screen.getByRole("button", { name: /^1 comment$/ })).toBeInTheDocument();
    act(() =>
      useCommentStore.getState().replace("wt-1", "worktree", {
        comments: ["a/One.ts", "a/Two.ts", "b/Three.ts", "c/Four.ts"].map((path, i) => c({ id: `c${i}`, pin: i + 1, path })),
        nextPin: 9,
        terminalDeliveries: [],
      }),
    );
    expect(screen.getByRole("button", { name: /^4 comments$/ })).toBeInTheDocument();
    expect(screen.getByText("One.ts")).toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy as text" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Schedule/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send to agent…" })).toBeEnabled();
  });

  it("goes waiting -> pasting from terminal-delivery pushes only, and hides Cancel while pasting", () => {
    seed([], [makeDelivery({ id: "d1", state: "waiting", commentCount: 3, waitsBehind: 1, ...agent1 })]);
    mount();
    expect(screen.getByText("Sending 3 to Agent 1 · waiting until ready")).toBeInTheDocument();
    expect(screen.getByText("· waits behind 1 scheduled message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel · restore" })).toBeInTheDocument();

    act(() => useCommentStore.getState().applyDelivery(makeDelivery({ id: "d1", state: "pasting", commentCount: 3, waitsBehind: 1, ...agent1 })));
    expect(screen.getByText("Sending 3 to Agent 1 · pasting…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel · restore" })).toBeNull();
    expect(screen.queryByText(/waits behind/)).toBeNull();
  });

  it("while a send waits, new comments show '· N new' with Send and expand into the list (R1F-13)", () => {
    seed(
      [c({ id: "1", pin: 1 }), c({ id: "2", pin: 2 }), c({ id: "3", pin: 3 })],
      [makeDelivery({ id: "d1", state: "waiting", commentCount: 4, ...agent1 })],
    );
    mount();
    const more = screen.getByRole("button", { name: /· 3 new/ });
    expect(screen.getByRole("button", { name: "Send to agent…" })).toBeInTheDocument();
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Send 3 to agent…" })).toBeInTheDocument();
  });

  it("with no new comments the sending strip has no Send control (R1F-13)", () => {
    seed([], [makeDelivery({ id: "d1", state: "waiting", commentCount: 4, ...agent1 })]);
    mount();
    expect(screen.queryByRole("button", { name: /Send to agent/ })).toBeNull();
    expect(screen.queryByText(/new$/)).toBeNull();
  });

  it("Copy as text swaps in the check icon once copied (R1F-14)", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    seed([c({ id: "1", pin: 1 })]);
    mount();
    const btn = screen.getByRole("button", { name: "Copy as text" });
    expect(btn.querySelector("svg.lucide-check")).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(btn.querySelector("svg.lucide-check")).not.toBeNull());
  });

  it("pluralises the waits-behind line", () => {
    seed([], [makeDelivery({ state: "waiting", waitsBehind: 2, ...agent1 })]);
    mount();
    expect(screen.getByText("· waits behind 2 scheduled messages")).toBeInTheDocument();
  });

  it("Cancel · restore calls the daemon and forgets the delivery", async () => {
    const api = makeApi();
    seed([], [makeDelivery({ id: "d1", state: "waiting", ...agent1 })]);
    mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Cancel · restore" }));
    await waitFor(() => expect(api.cancelTerminalDelivery).toHaveBeenCalledWith("d1"));
    await waitFor(() => expect(screen.queryByText(/Sending/)).toBeNull());
  });

  it("a 409 delivery_pasting on Cancel is explained inline", async () => {
    const { ReviewApiError } = await import("@/api/errors");
    const api = makeApi({ cancelTerminalDelivery: vi.fn().mockRejectedValue(new ReviewApiError("x", 409, "delivery_pasting")) });
    seed([], [makeDelivery({ id: "d1", state: "waiting", ...agent1 })]);
    mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Cancel · restore" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Already pasting");
  });

  it("timed out: exact copy, Retry re-posts the event's ids and message as a NEW delivery, Copy, Dismiss", async () => {
    const create = vi.fn().mockResolvedValue({ delivery: makeDelivery({ id: "d2", state: "waiting", ...agent1 }) });
    const api = makeApi({ createTerminalDelivery: create });
    seed(
      [c({ id: "a", pin: 1 }), c({ id: "b", pin: 2 })],
      [makeDelivery({ id: "d1", state: "timed_out", reason: "timed_out", sessionId: "s2", commentIds: ["a", "b", "gone"], message: "do it" })],
    );
    mount(api);
    expect(screen.getByText("Timed out · Agent 1 still busy · comments restored")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy as text" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toBe("wt-1");
    const body = create.mock.calls[0]![2];
    expect(body).toMatchObject({ sessionId: "s2", commentIds: ["a", "b"], message: "do it" });
    expect(body.terminalDeliveryId).not.toBe("d1");
    // the failed notice is replaced by the new in-flight one
    await waitFor(() => expect(screen.getByText(/^Sending \d+ to Agent 1 · waiting until ready$/)).toBeInTheDocument());
  });

  it("timed out can be dismissed", () => {
    seed([c()], [makeDelivery({ id: "d1", state: "timed_out", sessionId: "s2" })]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Timed out/)).toBeNull();
    expect(screen.getByRole("button", { name: /^1 comment$/ })).toBeInTheDocument();
  });

  it("agent exited: exact copy and Pick another opens the picker", async () => {
    seed([c()], [makeDelivery({ id: "d1", state: "failed", reason: "agent_exited", sessionId: "s2" })]);
    mount();
    expect(screen.getByText("Agent exited, not delivered")).toBeInTheDocument();
    expect(screen.getByText("comments restored")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pick another" }));
    expect(await screen.findByRole("dialog", { name: "Send 1 comment" })).toBeInTheDocument();
  });

  it("restored: count, reason and Dismiss (daemon clears the notice)", async () => {
    const api = makeApi();
    seed([c({ id: "a", restoredReason: "turn_cancelled" }), c({ id: "b", pin: 2, restoredReason: "turn_cancelled" }), c({ id: "d", pin: 3, restoredReason: "restart" })]);
    mount(api);
    expect(screen.getByText("3 comments restored")).toBeInTheDocument();
    expect(screen.getByText("· queued turn cancelled, last send didn't finish")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to agent…" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.dismissRestoredComments).toHaveBeenCalledWith("wt-1", "worktree"));
  });

  it("restored: Send to agent… stays available and opens the picker (R1F-02)", async () => {
    seed([c({ id: "a", restoredReason: "turn_cancelled" })]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Send to agent…" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("restored (compact): shows Send… next to Dismiss (R1F-02)", () => {
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as never;
    try {
      seed([c({ id: "a", restoredReason: "turn_cancelled" })]);
      mount();
      expect(screen.getByRole("button", { name: "Send…" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    } finally {
      window.matchMedia = orig;
    }
  });

  it("file chips: three files give three chips, four give three plus +1 more (R1F-05)", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => c({ id: `f${i}`, pin: i + 1, path: `src/dir/file${i}.ts` }));
    seed(mk(3));
    const { unmount } = mount();
    const chips = () => [...document.querySelectorAll(".comment-tray__fchip")].map((e) => e.textContent);
    expect(chips()).toHaveLength(3);
    expect(document.querySelector(".comment-tray__fname")?.textContent).toBe("file0.ts");
    unmount();
    seed(mk(4));
    mount();
    expect(chips()).toHaveLength(4);
    expect(chips()[3]).toBe("+1 more");
  });

  it("announces pending / timed out / restored politely", () => {
    seed([], [makeDelivery({ state: "waiting", commentCount: 2, ...agent1 })]);
    mount();
    const live = document.querySelector(".comment-tray [aria-live=polite]")!;
    expect(live).toHaveTextContent("Sending 2 to Agent 1, waiting until ready");
    act(() => useCommentStore.getState().applyDelivery(makeDelivery({ id: "d9", state: "timed_out", updatedAt: "2099-01-01T00:00:00Z", ...agent1 })));
    // the newer in-flight one still wins until it ends; end it
    act(() => useCommentStore.getState().applyDelivery(makeDelivery({ state: "cancelled", ...agent1 })));
    expect(live).toHaveTextContent("Timed out, Agent 1 still busy, comments restored");
  });

  it("over the limit: states the limits, Copy works, Send is disabled", () => {
    seed(Array.from({ length: 212 }, (_, i) => c({ id: `x${i}`, pin: i + 1, blockBytes: 700 })));
    mount();
    expect(screen.getByText(/^212 comments · \d+ KB$/)).toBeInTheDocument();
    expect(screen.getByText("over the limit (200 / 128 KB; Terminal 32 KB)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy as text" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("attached: '4 attached to main' with Detach; detach goes through the daemon", async () => {
    const api = makeApi();
    seed([1, 2, 3, 4].map((n) => c({ id: `a${n}`, pin: n, attachedTo: "session:s1" })));
    mount(api);
    expect(screen.getByText("4 attached to main")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(api.detachComments).toHaveBeenCalledWith("wt-1", "worktree", { commentIds: ["a1", "a2", "a3", "a4"] }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^4 comments$/ })).toBeInTheDocument());
  });
});

describe("CommentsTray offline (6.T8)", () => {
  it("disables Send and Copy with the reason and keeps the picker draft", () => {
    localStorage.setItem("vst-review-picker-draft:worktree:wt-1", "keep me");
    seed();
    mount(makeApi({ getConnectionState: () => "offline" }));
    expect(screen.getByText("Offline · reconnecting")).toBeInTheDocument();
    expect(screen.getByText("Send disabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to agent…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy as text" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy as text" })).toHaveAttribute("title", "Copy needs the daemon connection");
    expect(localStorage.getItem("vst-review-picker-draft:worktree:wt-1")).toBe("keep me");
  });
});

describe("CommentsTray expansion and layers", () => {
  it("expands on the count, is a labelled group, and Esc collapses it through the escape stack", () => {
    seed([c({ id: "a" }), c({ id: "b", pin: 2, path: "z.ts" })]);
    mount();
    const toggle = screen.getByRole("button", { name: /^2 comments$/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeNull();
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(openEscapeLayers()).toEqual(["tray"]);
    act(() => void dismissTop());
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(openEscapeLayers()).toEqual([]);
  });

  it("the list selection drives 'Send N to agent…' and the picker's comments", async () => {
    seed([c({ id: "a" }), c({ id: "b", pin: 2, path: "z.ts" }), c({ id: "d", pin: 3, path: "y.ts" })]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^3 comments$/ }));
    expect(screen.getByRole("button", { name: "Send 3 to agent…" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select comment 2"));
    expect(screen.getByRole("button", { name: "Send 2 to agent…" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send 2 to agent…" }));
    expect(await screen.findByRole("dialog", { name: "Send 2 comments" })).toBeInTheDocument();
  });

  it("Esc pressed in the composer or the terminal never collapses the tray (R101)", () => {
    seed([c({ id: "a" }), c({ id: "b", pin: 2 })]);
    render(
      <>
        <CommentsTray api={makeApi()} scopeId="wt-1" scopeKind="worktree" />
        <div className="chat-composer">
          <div role="textbox" aria-label="Message" tabIndex={0} />
        </div>
      </>,
    );
    const toggle = screen.getByRole("button", { name: /^2 comments$/ });
    fireEvent.click(toggle);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Escape" });
    // only the tools pane's own Esc handler routes to the escape stack; a key elsewhere is left alone
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("is hidden while the on-screen keyboard is open (7.T1)", () => {
    seed();
    kb.visible = true;
    const { container } = mount();
    expect(container.querySelector(".comment-tray")).toBeNull();
  });

  it("W2-01 — an open send picker stays mounted (with its state) when the keyboard opens; the tray itself steps aside", async () => {
    seed([c({ id: "a" }), c({ id: "b", pin: 2 })]);
    const api = makeApi();
    const { rerender, container } = render(<CommentsTray api={api} scopeId="wt-1" scopeKind="worktree" />);
    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/ }));
    const dlg = await screen.findByRole("dialog", { name: "Send 2 comments" });
    expect(within(dlg).getByRole("radio", { name: "Later" })).toHaveAttribute("aria-checked", "true");

    kb.visible = true;
    rerender(<CommentsTray api={api} scopeId="wt-1" scopeKind="worktree" />);
    const still = screen.getByRole("dialog", { name: "Send 2 comments" });
    expect(still).toBe(dlg);
    expect(within(still).getByRole("radio", { name: "Later" })).toHaveAttribute("aria-checked", "true");
    expect((container.querySelector(".comment-tray") as HTMLElement).style.display).toBe("none");
  });

  it("shows a load error with Retry when nothing loaded", async () => {
    const api = makeApi({ listComments: vi.fn().mockRejectedValue(new Error("boom")) });
    mount(api);
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Couldn’t load comments.")).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.listComments).toHaveBeenCalledTimes(2));
  });
});

describe("CommentsTray picker entry points and row taps (round 4)", () => {
  const realOpen = useWorkspaceStore.getState().setActiveFilePathAtLine;
  afterEach(() => useWorkspaceStore.setState({ setActiveFilePathAtLine: realOpen } as never));

  it("Schedule opens the one picker with When = Later; Send to agent… opens it with Now", async () => {
    seed([c({ id: "a" }), c({ id: "b", pin: 2 })]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Schedule$/ }));
    const dlg = await screen.findByRole("dialog", { name: "Send 2 comments" });
    expect(within(dlg).getByRole("radio", { name: "Later" })).toHaveAttribute("aria-checked", "true");
    expect(within(dlg).getByLabelText("Send at")).toBeInTheDocument();
    expect(within(dlg).getByText("Schedule", { selector: ".comment-picker__primary" })).toBeInTheDocument();
    fireEvent.keyDown(dlg, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Send to agent…" }));
    expect(within(await screen.findByRole("dialog", { name: "Send 2 comments" })).getByRole("radio", { name: "Now" })).toHaveAttribute("aria-checked", "true");
  });

  it("tapping a row opens the file at its line and the desktop list stays open", () => {
    const open = vi.fn();
    useWorkspaceStore.setState({ setActiveFilePathAtLine: open } as never);
    seed([c({ id: "a", path: "app.py", lineStart: 7, lineEnd: 7 })]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^1 comment$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open app.py at L7" }));
    expect(open).toHaveBeenCalledWith("wt-1", "app.py", 7);
    expect(screen.getByRole("separator", { name: "Resize comments list" })).toBeInTheDocument();
  });

  it("on a phone the list collapses after opening a file so the file is visible", () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("max-width: 768px"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
    const open = vi.fn();
    useWorkspaceStore.setState({ setActiveFilePathAtLine: open } as never);
    try {
      seed([c({ id: "a", path: "app.py", lineStart: 7, lineEnd: 7 })]);
      mount();
      fireEvent.click(screen.getByRole("button", { name: /^1 comment$/ }));
      fireEvent.click(screen.getByRole("button", { name: "Open app.py at L7" }));
      expect(open).toHaveBeenCalledWith("wt-1", "app.py", 7);
      expect(screen.queryByRole("separator")).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});
