import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMockApi } from "@/api/mock";
import type { NormalizedEvent, Session, SessionMeta } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { ChatPane } from "./ChatPane";

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

  it("a non-archived session still renders the live composer", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={jsonSession("js-live")} visible />);
    expect(await screen.findByRole("textbox", { name: /message/i })).toBeTruthy();
    expect(
      screen.queryByText("This session has been archived. Start a new agent to continue."),
    ).toBeNull();
  });
});
