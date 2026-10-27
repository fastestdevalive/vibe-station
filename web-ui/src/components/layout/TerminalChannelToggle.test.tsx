import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Mode, Session } from "@/api/types";
import { createMockApi } from "@/api/mock";
import { __resetForDemo, useModesStore } from "@/store/modesStore";
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
  beforeEach(() => {
    useModesStore.getState()._reset();
    // Also drop the module singletons (pendingLoad / sharedApi / sharedRefs) so
    // test order can't leak a stale subscription or in-flight load (review #21).
    __resetForDemo();
  });
  it("shows for a worktree-backed tmux agent whose CLI has an importer, switches on confirm, and shows NO warning", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<TerminalChannelToggle api={api} session={session()} />);

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);
    // claude imports its history → no lossy-switch warning in the dialog.
    expect(screen.queryByText(/won't be imported into Rich Chat/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Switch to Rich Chat/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("sess-main", "json", undefined));
  });

  it("shows for a CLI without a native-history importer (cursor) and warns before the lossy switch", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<TerminalChannelToggle api={api} session={session({ modeId: "mode-2" })} />);

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);
    // cursor can't import → the confirm dialog carries the lossy-switch warning.
    await screen.findByText(/won't be imported into Rich Chat/i);
    expect(screen.queryByText(/backfilled/i)).toBeNull();
    // The toggle still works (lossy return is not a block).
    await userEvent.click(screen.getByRole("button", { name: /Switch to Rich Chat/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("sess-main", "json", undefined));
  });

  it("hides for a CLI without Rich Chat support (pi: supportsJson false)", async () => {
    const api = createMockApi({
      modes: [{ id: "mode-pi", name: "Pi", cli: "pi", context: "", icon: "pi" }],
    });
    const listSpy = vi.spyOn(api, "getSupportedClis");
    render(<TerminalChannelToggle api={api} session={session({ modeId: "mode-pi" })} />);
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: /Rich Chat/i })).toBeNull();
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
    await waitFor(() => expect(spy).toHaveBeenCalledWith("sess-main", "json", undefined));
  });

  it("hides when the session is already on the JSON channel", () => {
    render(<TerminalChannelToggle api={createMockApi()} session={session({ channel: "json" })} />);
    expect(screen.queryByRole("button", { name: /Rich Chat/i })).toBeNull();
  });

  it("hides the toggle for a CLI that can't run Rich Chat (pi, terminal-only)", async () => {
    // Render pi directly. The toggle is absent while the capability lookup is
    // in flight (cli/supportsJson reset to null on each effect run), so wait
    // until the lookup has RESOLVED before asserting — this proves it stays
    // hidden because pi can't run Rich Chat, not merely hidden during the
    // loading window. (A json-capable CLI like claude/cursor shows the toggle
    // after resolution — see the tests above — so if the `supportsJson ===
    // false` check were removed, `cli` would resolve to pi and the button
    // would appear here.)
    const api = createMockApi();
    const getClisSpy = vi.spyOn(api, "getSupportedClis");
    vi.spyOn(api, "listModes").mockResolvedValue([
      { id: "mode-pi", name: "Pi", cli: "pi", context: "" } as Mode,
    ]);
    render(
      <TerminalChannelToggle api={api} session={session({ id: "sess-pi", modeId: "mode-pi" })} />,
    );

    // Let the capability lookup run to completion (cli -> pi, supportsJson -> false).
    await waitFor(() => expect(getClisSpy).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: /Rich Chat/i })).toBeNull();
  });

  it("shows the toggle for an agy session", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listModes").mockResolvedValue([
      { id: "mode-agy", name: "Antigravity", cli: "agy", context: "" } as Mode,
    ]);
    render(
      <TerminalChannelToggle api={api} session={session({ id: "sess-agy", modeId: "mode-agy" })} />,
    );

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Switch to Rich Chat" })).toBeTruthy();
  });

  it("shows toggle when session modeId is null, opens picker, and switches channel with selected modeId", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<TerminalChannelToggle api={api} session={session({ modeId: null })} />);

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);

    expect(await screen.findByText("Choose a mode for Rich Chat")).toBeTruthy();
    expect(screen.getByText(/Pick a mode for Rich Chat\./)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Use this mode" }));
    expect(await screen.findByText("Switch to Rich Chat?")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Switch to Rich Chat" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("sess-main", "json", "mode-1"));
  });

  it("shows toggle when mode was deleted, filters out CLIs without Rich Chat support, and calls with chosen mode", async () => {
    const api = createMockApi({
      modes: [
        { id: "m-claude", name: "Claude Mode", cli: "claude", context: "" },
        { id: "m-pi", name: "Pi Mode", cli: "pi", context: "" },
      ],
    });
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<TerminalChannelToggle api={api} session={session({ modeId: "deleted-mode" })} />);

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);

    // Picker should only list claude (supportsJson true), pi is filtered out
    const select = (await screen.findByLabelText("Mode")) as HTMLSelectElement;
    expect(select.children.length).toBe(1);
    expect(select.value).toBe("m-claude");

    await userEvent.click(screen.getByRole("button", { name: "Use this mode" }));
    await userEvent.click(screen.getByRole("button", { name: "Switch to Rich Chat" }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith("sess-main", "json", "m-claude"));
  });

  it("cancel at picker does not switch channel", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<TerminalChannelToggle api={api} session={session({ modeId: null })} />);

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);

    await screen.findByText("Choose a mode for Rich Chat");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Choose a mode for Rich Chat")).toBeNull();
    expect(screen.queryByText("Switch to Rich Chat?")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("cancel at confirm dialog after picking mode does not switch channel", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<TerminalChannelToggle api={api} session={session({ modeId: null })} />);

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);

    await screen.findByText("Choose a mode for Rich Chat");
    await userEvent.click(screen.getByRole("button", { name: "Use this mode" }));

    expect(await screen.findByText("Switch to Rich Chat?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Switch to Rich Chat?")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("becomes mode-missing when mode is deleted from modesStore while mounted", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionChannel");
    render(<TerminalChannelToggle api={api} session={session({ modeId: "mode-1" })} />);

    // Initially valid mode -> toggle is shown
    await screen.findByRole("button", { name: /Rich Chat/i });

    // Mode is deleted while mounted
    await act(async () => {
      await api.deleteMode("mode-1");
    });

    // Clicking toggle now opens the mode picker because mode is missing
    const toggle = screen.getByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);

    expect(await screen.findByText("Choose a mode for Rich Chat")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Use this mode" }));
    await userEvent.click(screen.getByRole("button", { name: "Switch to Rich Chat" }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith("sess-main", "json", "mode-2"));
  });

  it("shows empty state when no Rich Chat-capable modes exist", async () => {
    const api = createMockApi({
      modes: [
        { id: "m-pi", name: "Pi", cli: "pi", context: "" },
      ],
    });
    render(<TerminalChannelToggle api={api} session={session({ modeId: null })} />);

    const toggle = await screen.findByRole("button", { name: /Rich Chat/i });
    await userEvent.click(toggle);

    expect(
      await screen.findByText("No Rich Chat-capable modes — create one in Settings → Modes."),
    ).toBeTruthy();
    const confirmBtn = screen.getByRole("button", { name: "Use this mode" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });
});

