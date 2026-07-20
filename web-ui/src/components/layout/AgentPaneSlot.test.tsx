import { useEffect, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";

// Instrument TerminalPane to count mounts/unmounts and expose its sessionId prop.
let terminalMounts = 0;
let terminalUnmounts = 0;

vi.mock("./TerminalPane", () => ({
  TerminalPane: ({
    sessionId,
    channelToggle,
  }: {
    sessionId: string | null;
    channelToggle?: ReactNode;
  }) => {
    useEffect(() => {
      terminalMounts += 1;
      return () => {
        terminalUnmounts += 1;
      };
    }, []);
    // The real TerminalPane decides the toggle's placement (top-right overlay
    // while live, in-flow below the exited banner). Here we just surface whether
    // AgentPaneSlot handed it the toggle at all.
    return (
      <div data-testid="terminal" data-session={sessionId ?? "null"}>
        {channelToggle}
      </div>
    );
  },
}));

vi.mock("./ChatPane", () => ({
  ChatPane: ({ visible }: { visible: boolean }) => (
    <div data-testid="chatpane" data-visible={String(visible)} />
  ),
}));

// The channel toggle fetches modes on its own; stub it out — this suite only
// asserts the terminal/chat remount invariant.
vi.mock("./TerminalChannelToggle", () => ({
  TerminalChannelToggle: () => <div data-testid="channel-toggle" />,
}));

// Same reasoning: the terminal upload control (item 3) also fetches modes on
// its own — stub it out too.
vi.mock("./TerminalAttachmentUpload", () => ({
  TerminalAttachmentUpload: () => <div data-testid="attachment-upload" />,
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

  it("hands the channel toggle to TerminalPane and shows the upload overlay for a live terminal session", () => {
    const { container } = render(
      <AgentPaneSlot api={api} sessionId="tty1" session={session("tty1", "tmux")} />,
    );
    expect(container.querySelector('[data-testid="channel-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="attachment-upload"]')).not.toBeNull();
  });

  it("keeps handing TerminalPane the channel toggle when exited, but hides the upload overlay (Resume banner bug)", () => {
    // The channel toggle now lives inside TerminalPane, which renders it in
    // normal flow BELOW its own "Session exited / Resume" banner (no overlap),
    // so AgentPaneSlot keeps passing it even when exited. The upload overlay is
    // a plain top-corner overlay that only makes sense live, so it stays gated.
    const exited: Session = { ...session("tty1", "tmux"), lifecycleState: "exited" };
    const { container } = render(<AgentPaneSlot api={api} sessionId="tty1" session={exited} />);
    expect(terminalMounts).toBe(1);
    expect(container.querySelector('[data-testid="terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="attachment-upload"]')).toBeNull();
  });
});
