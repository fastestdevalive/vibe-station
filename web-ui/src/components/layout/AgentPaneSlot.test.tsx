import { useEffect } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";

// Instrument TerminalPane to count mounts/unmounts and expose its sessionId prop.
let terminalMounts = 0;
let terminalUnmounts = 0;

vi.mock("./TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: string | null }) => {
    useEffect(() => {
      terminalMounts += 1;
      return () => {
        terminalUnmounts += 1;
      };
    }, []);
    return <div data-testid="terminal" data-session={sessionId ?? "null"} />;
  },
}));

vi.mock("./ChatPane", () => ({
  ChatPane: ({ visible }: { visible: boolean }) => (
    <div data-testid="chatpane" data-visible={String(visible)} />
  ),
}));

// Import AFTER the mocks are registered (vi.mock is hoisted, but keep it explicit).
import { AgentPaneSlot } from "./AgentPaneSlot";

const api = {} as unknown as ApiInstance;

function session(id: string, channel: "tmux" | "pty" | "json"): Session {
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
    channel,
    createdAt: "",
  };
}

describe("AgentPaneSlot remount invariant (4.T5 / Decision 14)", () => {
  beforeEach(() => {
    terminalMounts = 0;
    terminalUnmounts = 0;
  });

  it("keeps TerminalPane mounted when switching a tab between TTY and JSON agents", () => {
    const { container, rerender } = render(
      <AgentPaneSlot api={api} sessionId="tty1" session={session("tty1", "tmux")} />,
    );
    const term = () => container.querySelector('[data-testid="terminal"]');
    const chat = () => container.querySelector('[data-testid="chatpane"]');

    expect(terminalMounts).toBe(1);
    expect(term()?.getAttribute("data-session")).toBe("tty1");
    expect(chat()?.getAttribute("data-visible")).toBe("false");

    // TTY → JSON: terminal must NOT remount; it receives sessionId=null.
    rerender(<AgentPaneSlot api={api} sessionId="js1" session={session("js1", "json")} />);
    expect(terminalMounts).toBe(1);
    expect(terminalUnmounts).toBe(0);
    expect(term()?.getAttribute("data-session")).toBe("null");
    expect(chat()?.getAttribute("data-visible")).toBe("true");

    // JSON → TTY: still no remount; the real sessionId flows back in.
    rerender(<AgentPaneSlot api={api} sessionId="tty2" session={session("tty2", "pty")} />);
    expect(terminalMounts).toBe(1);
    expect(terminalUnmounts).toBe(0);
    expect(term()?.getAttribute("data-session")).toBe("tty2");
    expect(chat()?.getAttribute("data-visible")).toBe("false");
  });

  it("leaves TTY behavior unchanged for a terminal-channel agent (5.T4)", () => {
    const { container } = render(
      <AgentPaneSlot api={api} sessionId="tty1" session={session("tty1", "tmux")} />,
    );
    expect(terminalMounts).toBe(1);
    expect(container.querySelector('[data-testid="terminal"]')?.getAttribute("data-session")).toBe("tty1");
    expect(container.querySelector('[data-testid="chatpane"]')?.getAttribute("data-visible")).toBe("false");
  });
});
