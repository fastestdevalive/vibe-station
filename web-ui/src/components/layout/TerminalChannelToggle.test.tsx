import { act, render, screen, waitFor } from "@testing-library/react";
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

  it("hides the toggle for a CLI that can't run Rich Chat (agy, terminal-only)", async () => {
    // Render agy directly. The toggle is absent while the capability lookup is
    // in flight (cli/supportsJson reset to null on each effect run), so wait
    // until the lookup has RESOLVED before asserting — this proves it stays
    // hidden because agy can't run Rich Chat, not merely hidden during the
    // loading window. (A json-capable CLI like claude/cursor shows the toggle
    // after resolution — see the tests above — so if the `supportsJson ===
    // false` check were removed, `cli` would resolve to agy and the button
    // would appear here.)
    const api = createMockApi();
    const getClisSpy = vi.spyOn(api, "getSupportedClis");
    vi.spyOn(api, "listModes").mockResolvedValue([
      { id: "mode-agy", name: "Antigravity", cli: "agy", context: "" } as Mode,
    ]);
    render(
      <TerminalChannelToggle api={api} session={session({ id: "sess-agy", modeId: "mode-agy" })} />,
    );

    // Let the capability lookup run to completion (cli -> agy, supportsJson -> false).
    await waitFor(() => expect(getClisSpy).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: /Rich Chat/i })).toBeNull();
  });
});
