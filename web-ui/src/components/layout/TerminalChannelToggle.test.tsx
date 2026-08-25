import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Mode, Session } from "@/api/types";
import { createMockApi } from "@/api/mock";
import { TerminalChannelToggle } from "./TerminalChannelToggle";

// The mock defines mode-1 → claude (has importer) and mode-2 → cursor (no importer).
function session(extra: Partial<Session> = {}): Session {
  return {
    id: "sess-main",
    worktreeId: "wt-1",
    projectId: "proj-a",
    modeId: "mode-1",
    type: "agent",
    isMain: true,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: "sess-main",
    channel: "tmux",
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe("TerminalChannelToggle (terminal→JSON)", () => {
  it("shows for a worktree-backed tmux agent whose CLI has an importer, switches on confirm, and shows NO warning", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<TerminalChannelToggle api={api} session={session()} />);

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);
    // claude imports its history → no lossy-switch warning in the dialog.
    expect(screen.queryByText(/won't be imported into Rich Chat/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Switch to Rich Chat/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("sess-main", "json"));
  });

  it("shows for a CLI without a native-history importer (cursor) and warns before the lossy switch", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<TerminalChannelToggle api={api} session={session({ modeId: "mode-2" })} />);

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);
    // cursor can't import → the confirm dialog carries the lossy-switch warning.
    await screen.findByText(/won't be imported into Rich Chat/i);
    // The toggle still works (lossy return is not a block).
    await userEvent.click(screen.getByRole("button", { name: /Switch to Rich Chat/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("sess-main", "json"));
  });

  it("hides for a plain (non-agent) terminal session", () => {
    render(
      <TerminalChannelToggle
        api={createMockApi()}
        session={session({ type: "terminal", modeId: null })}
      />,
    );
    expect(screen.queryByRole("button", { name: /Rich Chat/i })).toBeNull();
  });

  it("shows for a direct (non-worktree) session — the daemon supports the toggle for direct sessions too", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(
      <TerminalChannelToggle api={api} session={session({ worktreeId: null })} />,
    );

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: /Switch to Rich Chat/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("sess-main", "json"));
  });

  it("hides when the session is already on the JSON channel", () => {
    render(<TerminalChannelToggle api={createMockApi()} session={session({ channel: "json" })} />);
    expect(screen.queryByRole("button", { name: /Rich Chat/i })).toBeNull();
  });

  it("shows the toggle for every eligible agent CLI (including no-importer agy) across a no-remount session switch", async () => {
    // This pane slot is not keyed by session id (Decision 14 remount
    // invariant), so switching tabs re-renders this component with new props
    // instead of remounting. The gate is gone — visibility no longer depends
    // on the CLI, so the toggle stays visible when switching from an
    // importer-backed CLI (claude) to one without (agy).
    const api = createMockApi();
    vi.spyOn(api, "listModes").mockResolvedValue([
      { id: "mode-claude", name: "Claude", cli: "claude", context: "" } as Mode,
      { id: "mode-agy", name: "Antigravity", cli: "agy", context: "" } as Mode,
    ]);
    const { rerender } = render(
      <TerminalChannelToggle api={api} session={session({ modeId: "mode-claude" })} />,
    );
    await screen.findByRole("button", { name: /Rich Chat/i }); // visible for claude

    rerender(
      <TerminalChannelToggle
        api={api}
        session={session({ id: "sess-agy", modeId: "mode-agy" })}
      />,
    );
    // agy is eligible too now (gate removed) — the toggle stays visible once
    // its mode/capability resolve.
    await waitFor(() => expect(vi.mocked(api.listModes).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByRole("button", { name: /Rich Chat/i })).toBeTruthy();
  });
});
