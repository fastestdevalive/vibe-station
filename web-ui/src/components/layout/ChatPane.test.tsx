import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";
import { createMockApi } from "@/api/mock";
import type { NormalizedEvent, Session, SessionMeta } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { MessageList } from "@/components/chat/MessageList";
import { ChatPane } from "./ChatPane";

// Wraps the REAL MessageList (delegates every call to it, via importOriginal)
// so the rest of this file's tests keep exercising real rendering — the mock
// only adds the ability to inspect the exact props ChatPane passed on each
// render, which is otherwise unobservable (1.T7 needs to assert the debounced
// `thinking` prop's value across renders, not anything visibly different in
// the DOM).
vi.mock("@/components/chat/MessageList", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/chat/MessageList")>();
  return { ...actual, MessageList: vi.fn(actual.MessageList) };
});

function meta(sessionId: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId,
    channel: "json",
    cli: "claude",
    turnState: "idle",
    queueDepth: 0,
    queuedTurnIds: [],
    editingTurnIds: [],
    ...extra,
  };
}

function jsonSession(id: string): Session {
  return {
    id,
    worktreeId: "wt-1",
    projectId: "proj-a",
    modeId: "mode-1",
    type: "agent",
    isMain: true,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: "",
    channel: "json",
    createdAt: new Date().toISOString(),
  };
}

function ev(id: string, extra: Partial<NormalizedEvent>): NormalizedEvent {
  return { id, sessionId: "js1", ts: "", provider: "claude", kind: "text", ...extra };
}

describe("ChatPane (4.T2)", () => {
  it("renders text, tool_use and tool_result from the replayed stream; thinking toggles", async () => {
    const api = createMockApi();
    api.__test.pushChatEvent("js1", ev("e1", { kind: "text", role: "assistant", text: "Here is the fix" }));
    api.__test.pushChatEvent("js1", ev("e2", { kind: "tool_use", toolName: "Bash", toolId: "tc1", toolInput: { command: "ls -la" } }));
    api.__test.pushChatEvent("js1", ev("e3", { kind: "tool_result", toolId: "tc1", toolResult: { content: "total 24" } }));
    api.__test.pushChatEvent("js1", ev("e4", { kind: "thinking", text: "let me reason about it" }));

    render(<ChatPane api={api} session={jsonSession("js1")} visible />);

    // Assistant markdown text.
    expect(await screen.findByText("Here is the fix")).toBeTruthy();
    // Tool card (name).
    expect(screen.getByText("Bash")).toBeTruthy();

    // Thinking block collapsed by default; expands on click.
    const toggle = screen.getByRole("button", { name: /thinking/i });
    expect(screen.queryByText("let me reason about it")).toBeNull();
    await userEvent.setup().click(toggle);
    expect(screen.getByText("let me reason about it")).toBeTruthy();
  });

  it("renders nothing active when hidden (keeps the pane mounted but idle)", () => {
    const api = createMockApi();
    const { container } = render(<ChatPane api={api} session={jsonSession("js2")} visible={false} />);
    expect(container.querySelector(".chat-pane--hidden")).toBeTruthy();
  });

  it("shows the empty state for a JSON session with no history", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={jsonSession("js3")} visible />);
    expect(await screen.findByText("Start chatting")).toBeTruthy();
  });

  it("relocates a queued turn to the tray, out of the inline conversation log", async () => {
    const api = createMockApi();
    api.__test.pushChatEvent("jsq", ev("u1", { kind: "user", role: "user", text: "queued msg", turnId: "q1" }));
    render(<ChatPane api={api} session={jsonSession("jsq")} visible />);
    // Initially (no meta) the message sits in the conversation log.
    expect(await screen.findByText("queued msg")).toBeTruthy();

    // Meta marks q1 as queued → it moves to the tray and leaves the log.
    act(() => {
      api.__test.emit({
        type: "session:meta",
        sessionId: "jsq",
        meta: meta("jsq", { turnState: "thinking", queueDepth: 1, queuedTurnIds: ["q1"] }),
      });
    });

    const tray = await screen.findByRole("list", { name: "Queued messages" });
    expect(within(tray).getByText("queued msg")).toBeTruthy();
    expect(within(tray).getByLabelText("Send now")).toBeTruthy();
    expect(within(screen.getByRole("log")).queryByText("queued msg")).toBeNull();
  });

  it("3.T2 — an archived session's composer renders disabled with the exact expected copy", async () => {
    const api = createMockApi();
    const archived: Session = { ...jsonSession("js-archived"), archivedAt: new Date().toISOString() };
    render(<ChatPane api={api} session={archived} visible />);

    // Exact copy from the original F5 mockup (Decision 4 / CUJ 3) — no
    // paraphrasing, and no live textarea/send control in its place.
    expect(
      await screen.findByText("This session has been archived. Start a new agent to continue."),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /send message/i })).toBeNull();
  });

  it("scales its --font-size-* CSS variables with the shared terminalFontScale (Aa −/+ control)", async () => {
    const api = createMockApi();
    useWorkspaceStore.setState({ terminalFontScale: 1.2 });
    try {
      const { container } = render(<ChatPane api={api} session={jsonSession("js-zoom")} visible />);
      await screen.findByText("Start chatting");
      const pane = container.querySelector(".chat-pane") as HTMLElement;
      // Base --font-size-sm is 12px; at 1.2x scale it should round to 14px.
      expect(pane.style.getPropertyValue("--font-size-sm")).toBe("14px");
      expect(pane.style.getPropertyValue("--font-size-base")).toBe("17px");
    } finally {
      useWorkspaceStore.setState({ terminalFontScale: 1 });
    }
  });

  it("`.chat-pane` re-declares font-size from the scaled token, so inherited text zooms too", () => {
    // jsdom resolves neither stylesheets nor var(), so the *rendered* size of a
    // message bubble can't be asserted here. The regression guarded instead is
    // structural: without this declaration, `body`'s font-size (computed from
    // the UNSCALED root token) inherits into every element that doesn't read a
    // --font-size-* var itself — user messages and assistant markdown — and
    // only tool cards / the composer follow the zoom.
    const css = readFileSync(resolve(process.cwd(), "src/styles/chat.css"), "utf8");
    const block = /\.chat-pane \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/font-size:\s*var\(--font-size-base\)/);
  });

  it("a non-archived session still renders the live composer", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={jsonSession("js-live")} visible />);
    expect(await screen.findByRole("textbox", { name: /message/i })).toBeTruthy();
    expect(
      screen.queryByText("This session has been archived. Start a new agent to continue."),
    ).toBeNull();
  });
});

describe("ChatPane thinking-state debounce (1.T7 — Decision 2 anti-flicker)", () => {
  it("does not flip the debounced `thinking` prop false during rapid turnState oscillation, but commits once a value holds past 250ms", () => {
    vi.useFakeTimers();
    try {
      const api = createMockApi();
      // Needs at least one event so ChatPane's `isEmpty` branch doesn't render
      // the empty-state placeholder INSTEAD of MessageList — otherwise MessageList
      // never mounts for this session and there's nothing to inspect props on.
      api.__test.pushChatEvent("js-debounce", ev("u1", { kind: "user", role: "user", text: "hi", turnId: "t1" }));
      render(<ChatPane api={api} session={jsonSession("js-debounce")} visible />);
      const mockedMessageList = MessageList as unknown as Mock;
      mockedMessageList.mockClear();

      // Settle into a steady "thinking" state first (past the debounce window).
      act(() => {
        api.__test.emit({
          type: "session:meta",
          sessionId: "js-debounce",
          meta: meta("js-debounce", { turnState: "thinking" }),
        });
      });
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(mockedMessageList.mock.calls.at(-1)![0].thinking).toBe(true);

      // Rapidly oscillate thinking -> tool -> thinking -> tool, each change
      // arriving well inside the 250ms debounce window (it resets on every
      // `meta?.turnState` change) — the displayed `thinking` prop must stay
      // true (its last COMMITTED value) throughout, never dropping to false.
      mockedMessageList.mockClear();
      const states: SessionMeta["turnState"][] = ["tool", "thinking", "tool"];
      for (const turnState of states) {
        act(() => {
          api.__test.emit({ type: "session:meta", sessionId: "js-debounce", meta: meta("js-debounce", { turnState }) });
        });
        act(() => {
          vi.advanceTimersByTime(80); // < 250ms — debounce timer keeps resetting
        });
      }
      const thinkingPropsDuringOscillation = mockedMessageList.mock.calls.map((c) => c[0].thinking);
      // Guard against a vacuous pass: this assertion is meaningless if the
      // mock never actually re-rendered during the oscillation.
      expect(thinkingPropsDuringOscillation.length).toBeGreaterThan(0);
      expect(thinkingPropsDuringOscillation.every((t) => t === true)).toBe(true);

      // Now let the final value ("tool") hold past the debounce window with no
      // further change — it DOES commit, and `thinking` flips to false.
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(mockedMessageList.mock.calls.at(-1)![0].thinking).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ChatPane atBottom threading (MessageList → ChatPane → StatusBar)", () => {
  it("passes MessageList's onAtBottomChange through, so the footer busy dots follow the scroll position", async () => {
    const api = createMockApi();
    api.__test.pushChatEvent("js-atbottom", ev("u1", { kind: "user", role: "user", text: "hi", turnId: "t1" }));
    const { container } = render(<ChatPane api={api} session={jsonSession("js-atbottom")} visible />);
    const mockedMessageList = MessageList as unknown as Mock;

    // Busy, but still at the live edge → in-feed indicator covers it, footer
    // stays dots-free.
    act(() => {
      api.__test.emit({
        type: "session:meta",
        sessionId: "js-atbottom",
        meta: meta("js-atbottom", { turnState: "thinking" }),
      });
    });
    expect(container.querySelector(".chat-statusbar__busy--hidden")).toBeTruthy();

    const onAtBottomChange = mockedMessageList.mock.calls.at(-1)![0].onAtBottomChange;
    expect(typeof onAtBottomChange).toBe("function");

    // Scrolled away while busy → the footer shows the dots.
    act(() => onAtBottomChange(false));
    expect(container.querySelector(".chat-statusbar__busy--hidden")).toBeNull();
    expect(container.querySelector(".chat-statusbar__busy")).toBeTruthy();

    // Back at the bottom → the dots hide again (the box stays reserved).
    act(() => onAtBottomChange(true));
    expect(container.querySelector(".chat-statusbar__busy--hidden")).toBeTruthy();
  });

  it("resets to at-bottom when the pane switches session, so stale dots don't survive the MessageList remount", async () => {
    const api = createMockApi();
    api.__test.pushChatEvent("js-a", ev("u1", { kind: "user", role: "user", text: "hi", turnId: "t1" }));
    api.__test.pushChatEvent("js-b", ev("u2", { kind: "user", role: "user", text: "hello", turnId: "t2" }));
    const { container, rerender } = render(<ChatPane api={api} session={jsonSession("js-a")} visible />);
    const mockedMessageList = MessageList as unknown as Mock;

    act(() => {
      api.__test.emit({ type: "session:meta", sessionId: "js-a", meta: meta("js-a", { turnState: "thinking" }) });
    });
    act(() => mockedMessageList.mock.calls.at(-1)![0].onAtBottomChange(false));
    expect(container.querySelector(".chat-statusbar__busy--hidden")).toBeNull();

    // Switch to a different conversation: MessageList remounts pinned to the
    // bottom, so the footer must not keep the previous session's dots — and no
    // scroll event will ever fire to correct it.
    rerender(<ChatPane api={api} session={jsonSession("js-b")} visible />);
    act(() => {
      api.__test.emit({ type: "session:meta", sessionId: "js-b", meta: meta("js-b", { turnState: "thinking" }) });
    });
    expect(container.querySelector(".chat-statusbar__busy--hidden")).toBeTruthy();
  });
});
