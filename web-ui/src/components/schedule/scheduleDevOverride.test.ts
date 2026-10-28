import { describe, expect, it } from "vitest";
import { SCHEDULE_DEV_SCENARIOS, devScheduleSnapshot } from "./scheduleDevOverride";

describe("devScheduleSnapshot", () => {
  it("builds a Terminal snapshot for every scenario", () => {
    for (const sc of SCHEDULE_DEV_SCENARIOS) {
      const snap = devScheduleSnapshot(sc);
      const rows = [...snap.scheduledSends, ...snap.scheduledFailed, ...snap.scheduledSent];
      expect(rows.length, sc).toBeGreaterThan(0);
      expect(rows.every((r) => r.channel === "tmux"), sc).toBe(true);
    }
  });

  it("maps each state scenario to its row kind and phase", () => {
    expect(devScheduleSnapshot("waiting").scheduledSends[0]?.phase).toBe("waiting");
    expect(devScheduleSnapshot("pasting").scheduledSends[0]?.phase).toBe("pasting");
    expect(devScheduleSnapshot("pending").scheduledSends[0]?.phase).toBe("scheduled");
    expect(devScheduleSnapshot("timed out").scheduledFailed[0]?.failureKind).toBe("timed_out");
    expect(devScheduleSnapshot("failed").scheduledFailed[0]?.failureKind).toBe("agent_exited");
    expect(devScheduleSnapshot("sent").scheduledSent).toHaveLength(1);
  });
});
