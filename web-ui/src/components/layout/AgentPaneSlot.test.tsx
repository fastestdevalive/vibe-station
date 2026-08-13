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
    isMain: true,
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

  it("3.T3 — hides the upload overlay for a session marked done (its pane is released)", () => {
    // "Mark as done" kills the tmux/pty process just like an exit does, so the
    // live-terminal-only upload overlay must be gated for `done` too.
    const done: Session = { ...session("tty1", "tmux"), state: "done", lifecycleState: "done" };
    const { container } = render(<AgentPaneSlot api={api} sessionId="tty1" session={done} />);
    expect(container.querySelector('[data-testid="terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="attachment-upload"]')).toBeNull();
  });

  it("keeps handing TerminalPane the channel toggle when exited, but hides the upload overlay (Resume banner bug)", () => {
    // The channel toggle now lives inside TerminalPane, which renders it in
    // normal flow BELOW its own "Session exited / Resume" banner (no overlap),
    // so AgentPaneSlot keeps passing it even when exited. The upload overlay is
    // a plain top-corner overlay that only makes sense live, so it stays gated.
    const exited: Session = { ...session("tty1", "tmux"), state: "exited", lifecycleState: "exited" };
    const { container } = render(<AgentPaneSlot api={api} sessionId="tty1" session={exited} />);
    expect(terminalMounts).toBe(1);
    expect(container.querySelector('[data-testid="terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="attachment-upload"]')).toBeNull();
  });

  it("2.T3 — a tab-strip drag-reorder (sortOrder-only change) does not remount the pane", () => {
    // TabsStrip/LeftSidebar never render TerminalPane/ChatPane themselves —
    // AgentPaneSlot only cares about `sessionId`/`session`, driven by
    // `activeSessionId` (Workspace.tsx), never by tab/row order. Reordering
    // changes a session's `sortOrder` (Part 03 Phase 2) and re-sorts the tab
    // strip's own list, but must never touch AgentPaneSlot's identity/props
    // in a way that remounts it.
    const s = session("tty1", "tmux");
    const { container, rerender } = render(
      <AgentPaneSlot api={api} sessionId="tty1" session={s} />,
    );
    expect(terminalMounts).toBe(1);

    rerender(<AgentPaneSlot api={api} sessionId="tty1" session={{ ...s, sortOrder: 42 }} />);
    expect(terminalMounts).toBe(1);
    expect(terminalUnmounts).toBe(0);
    expect(container.querySelector('[data-testid="terminal"]')?.getAttribute("data-session")).toBe("tty1");
  });

  // --- Colored border reflects live `.state`, not stale `.lifecycleState` ---
  // Regression: the live `session:state` WS handler (useServerSync.ts) only
  // ever patches `.state` on the session object, never `.lifecycleState` (that
  // field is only set from the initial REST fetch, or by the dev-only
  // state-simulation panel which patches both — masking this bug in manual
  // testing via that panel). Reading `.lifecycleState` for the border color
  // left it permanently stuck on the value from page load.
  it("borders the pane by `session.state`, ignoring a stale/mismatched `session.lifecycleState`", () => {
    const s: Session = {
      ...session("tty1", "tmux"),
      state: "waiting_for_human",
      lifecycleState: "exited", // deliberately stale/wrong — must be ignored
    };
    const { container } = render(<AgentPaneSlot api={api} sessionId="tty1" session={s} />);
    const root = container.querySelector(".agent-pane-slot");
    expect(root?.className).toContain("agent-pane-slot--waiting_for_human");
    expect(root?.className).not.toContain("agent-pane-slot--exited");
  });

  it("hides the status border entirely when the showAgentStatusBorders toggle is off", async () => {
    const { useWorkspaceStore } = await import("@/hooks/useStore");
    const prev = useWorkspaceStore.getState().showAgentStatusBorders;
    // Flip the store BEFORE mounting, so the component's initial render already
    // reflects it — a post-mount setState would need an act() wrapper here.
    useWorkspaceStore.setState({ showAgentStatusBorders: false });
    try {
      const s: Session = { ...session("tty1", "tmux"), state: "waiting_for_human" };
      const { container, unmount } = render(<AgentPaneSlot api={api} sessionId="tty1" session={s} />);
      const root = container.querySelector(".agent-pane-slot");
      expect(root?.className).not.toContain("agent-pane-slot--waiting_for_human");
      // Unmount before restoring the store so the restore-setState below (which
      // RTL's own auto-cleanup can't precede) doesn't update a still-subscribed,
      // still-mounted component outside of act().
      unmount();
    } finally {
      useWorkspaceStore.setState({ showAgentStatusBorders: prev });
    }
  });
});
