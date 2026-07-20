import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMockApi } from "@/api/mock";
import type { NormalizedEvent, Session, SessionMeta } from "@/api/types";
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
    label: "main",
    slot: "m",
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
});
