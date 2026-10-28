import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { Session } from "@/api/types";
import { __resetForDemo, useModesStore } from "@/store/modesStore";
import { ScheduleButton } from "./ScheduleButton";
import type { ScheduleRowData } from "./useScheduledSends";

// The mock defines mode-1 → claude (terminal delivery) and mode-2 → cursor (none).
function session(extra: Partial<Session> = {}): Session {
  return {
    id: "sess-main",
    worktreeId: "wt-1",
    projectId: "proj-a",
    modeId: "mode-1",
    type: "agent",
    isMain: true,
    name: "Agent 1",
    state: "idle",
    lifecycleState: "idle",
    tmuxName: "sess-main",
    channel: "tmux",
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

const fireAt = new Date(Date.now() + 3_600_000).toISOString();
const pending = (id: string, extra: object = {}): ScheduleRowData => ({ kind: "pending", id, message: id, fireAt, ...extra });

beforeEach(() => {
  useModesStore.getState()._reset();
  __resetForDemo();
});

describe("ScheduleButton", () => {
  it("shows no badge and the plain label with no rows", async () => {
    render(<ScheduleButton api={createMockApi()} session={session()} rows={[]} />);
    const btn = await screen.findByRole("button", { name: "Schedule message" });
    expect(btn.title).toBe("Schedule message");
    expect(btn.querySelector(".schedule-button__badge")).toBeNull();
    expect(btn.className).not.toContain("schedule-button--on");
  });

  it("badge counts pending + waiting + pasting; failed and sent rows are excluded (immediate rows never reach it: useScheduledSends drops them)", async () => {
    const rows: ScheduleRowData[] = [
      pending("a"),
      pending("b", { phase: "waiting" }),
      pending("c", { phase: "pasting" }),
      { kind: "failed", id: "f", message: "x", fireAt, failureReason: "r" },
      { kind: "sent", id: "s", message: "x", fireAt, sentAt: fireAt },
    ];
    render(<ScheduleButton api={createMockApi()} session={session()} rows={rows} />);
    const btn = await screen.findByRole("button", { name: "Schedule message (3 scheduled)" });
    expect(btn.querySelector(".schedule-button__badge")?.textContent).toBe("3");
    expect(btn.className).toContain("schedule-button--on");
  });

  it("is active (.on) for a strip with only failed rows but shows no badge", async () => {
    const rows: ScheduleRowData[] = [{ kind: "failed", id: "f", message: "x", fireAt, failureReason: "r" }];
    render(<ScheduleButton api={createMockApi()} session={session()} rows={rows} />);
    const btn = await screen.findByRole("button", { name: "Schedule message" });
    expect(btn.className).toContain("schedule-button--on");
    expect(btn.querySelector(".schedule-button__badge")).toBeNull();
  });

  it("toggles aria-expanded and opens the compose popover", async () => {
    const user = userEvent.setup();
    render(<ScheduleButton api={createMockApi()} session={session()} rows={[]} />);
    const btn = await screen.findByRole("button", { name: "Schedule message" });
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await user.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const dialog = await screen.findByRole("dialog", { name: "Schedule message" });
    expect(dialog.textContent).toContain("Agent 1 · Terminal");
    await user.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is disabled with a reason when the CLI has no terminal delivery", async () => {
    render(<ScheduleButton api={createMockApi()} session={session({ modeId: "mode-2" })} rows={[]} />);
    const btn = (await screen.findByRole("button", { name: "Schedule message" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("Scheduling isn't supported for this agent yet");
  });

  it("is hidden for Rich Chat, pty, non-agent and missing-mode sessions", async () => {
    const structural: Partial<Session>[] = [{ channel: "json" }, { channel: "pty" }, { type: "terminal" }];
    for (const c of structural) {
      const api = createMockApi();
      const spy = vi.spyOn(api, "getSupportedClis");
      const { container, unmount } = render(<ScheduleButton api={api} session={session(c)} rows={[]} />);
      await act(async () => {});
      // Structurally ineligible: nothing is even fetched.
      expect(spy, JSON.stringify(c)).not.toHaveBeenCalled();
      expect(container.querySelector("button"), JSON.stringify(c)).toBeNull();
      unmount();
    }
    // Eligible by shape but its mode is missing: the capability fetch happens and the mode gate alone hides the button.
    for (const modeId of ["mode-gone", null]) {
      const api = createMockApi();
      const spy = vi.spyOn(api, "getSupportedClis");
      const { container, unmount } = render(<ScheduleButton api={api} session={session({ modeId })} rows={[]} />);
      await waitFor(() => expect(spy).toHaveBeenCalled());
      await waitFor(() => expect(useModesStore.getState().loaded).toBe(true));
      await act(async () => {});
      expect(container.querySelector("button"), String(modeId)).toBeNull();
      unmount();
    }
  });
});
