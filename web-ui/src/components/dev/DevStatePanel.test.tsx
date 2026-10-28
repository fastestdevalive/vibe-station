import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "@/api/types";
import { useScheduleDevOverride } from "@/components/schedule/scheduleDevOverride";
import { useServerStore } from "@/hooks/useServerStore";
import { DevStatePanel } from "./DevStatePanel";

const session: Session = {
  id: "tty1",
  worktreeId: "wt-1",
  projectId: "proj-a",
  modeId: "mode-1",
  type: "agent",
  isMain: true,
  state: "idle",
  lifecycleState: "idle",
  tmuxName: "tty1",
  channel: "tmux",
  createdAt: "",
};

afterEach(() => {
  useScheduleDevOverride.setState({ bySession: {} });
  useServerStore.setState({ sessions: [] });
});

describe("DevStatePanel Terminal scheduled states (R100)", () => {
  it("applies and clears a canned scheduled-send snapshot for the selected session", async () => {
    useServerStore.setState({ sessions: [session] });
    render(<DevStatePanel />);
    fireEvent.keyDown(window, { key: "d", ctrlKey: true, shiftKey: true });
    const user = userEvent.setup();

    const apply = await screen.findByRole("button", { name: "Apply schedule" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(screen.getByLabelText("Session"), "tty1");
    await user.selectOptions(screen.getByLabelText("Terminal scheduled sends"), "all states");
    await user.click(apply);
    const snap = useScheduleDevOverride.getState().bySession.tty1!;
    expect(snap.scheduledSends.map((r) => r.phase)).toEqual(["scheduled", "waiting", "pasting"]);
    expect(snap.scheduledFailed.map((r) => r.failureKind)).toEqual(["timed_out", "agent_exited"]);
    expect(snap.scheduledSent).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(useScheduleDevOverride.getState().bySession.tty1).toBeUndefined();
  });
});
