import { describe, expect, it } from "vitest";
import { mkTask, minutesAgo } from "./taskFixtures";
import { chipLabel, chipLabels, countsText, groupTasks, isQuiet, stateText, summaryText, rowAriaLabel } from "./taskFormat";

const now = Date.now();

describe("taskFormat", () => {
  it("quiet applies only to running commands idle > 2 min", () => {
    expect(isQuiet(mkTask({ lastActivityAt: minutesAgo(3) }), now)).toBe(true);
    expect(isQuiet(mkTask({ lastActivityAt: minutesAgo(1) }), now)).toBe(false);
    expect(isQuiet(mkTask({ kind: "subagent", lastActivityAt: minutesAgo(30) }), now)).toBe(false);
    expect(isQuiet(mkTask({ state: "stale", lastActivityAt: minutesAgo(30) }), now)).toBe(false);
  });

  it("groups live (with quiet) before finished; summary counts exclude quiet from running", () => {
    const g = groupTasks(
      [
        mkTask({ id: "a" }),
        mkTask({ id: "b", lastActivityAt: minutesAgo(5) }),
        mkTask({ id: "c", state: "done", endedAt: minutesAgo(1) }),
      ],
      now,
    );
    expect(g.live.map((t) => t.id)).toEqual(["a", "b"]);
    expect(g.running.map((t) => t.id)).toEqual(["a"]);
    expect(g.quiet.map((t) => t.id)).toEqual(["b"]);
    expect(summaryText(g)).toBe("1 running · 1 quiet");
    expect(summaryText(groupTasks([mkTask({ state: "done" })], now))).toBe("1 finished");
  });

  it("chip labels: first 2 command tokens, <=24 chars, m:ss, max 3 then +N", () => {
    expect(chipLabel({ kind: "command", label: "cargo build --release -p vst" })).toBe("cargo build");
    expect(chipLabel({ kind: "command", label: "averyveryverylongcommandname --flag" }).length).toBeLessThanOrEqual(24);
    const live = ["a", "b", "c", "d"].map((id) => mkTask({ id, label: `cmd ${id}`, startedAt: new Date(now - 252_000).toISOString() }));
    const text = chipLabels(live, now);
    expect(text).toContain("cmd a 4:12");
    expect(text.endsWith("+1")).toBe(true);
  });

  it("chip labels: finished entries show their terminal word, never a clock", () => {
    const done = mkTask({
      id: "d",
      label: "npm run",
      state: "done",
      startedAt: new Date(now - 3_600_000).toISOString(),
      endedAt: new Date(now - 3_600_000 + 38_000).toISOString(),
    });
    const text = chipLabels([done], now + 3_600_000);
    expect(text).toBe("npm run done 38s");
    expect(text).not.toMatch(/\d+:\d\d/);
    expect(chipLabels([mkTask({ id: "f", label: "x", state: "failed" })], now)).toBe("x failed");
  });

  it("countsText joins non-zero parts with the tray vocabulary", () => {
    const t = (n: number) => Array.from({ length: n }, (_, i) => mkTask({ id: String(i) }));
    expect(countsText({ running: t(2), quiet: t(1), finished: t(3) })).toBe("2 running · 1 quiet · 3 finished");
    expect(countsText({ running: t(2), quiet: [], finished: [] })).toBe("2 running");
    expect(countsText({ running: [], quiet: [], finished: t(1) })).toBe("1 finished");
  });

  it("per-kind copy table", () => {
    const started = new Date(now - 252_000).toISOString();
    expect(stateText(mkTask({ startedAt: started }), now)).toBe("Background command · running 4m 12s");
    expect(stateText(mkTask({ state: "stale", reason: "No end signal from the agent" }), now)).toBe(
      "Ended or unknown · No end signal from the agent",
    );
    const sub = { kind: "subagent" as const, startedAt: new Date(now - 38_000).toISOString() };
    expect(stateText(mkTask(sub), now)).toBe("Subagent · running 38s");
    expect(stateText(mkTask({ ...sub, state: "done", endedAt: new Date(now).toISOString() }), now)).toBe("Subagent · done in 38s");
    expect(stateText(mkTask({ ...sub, state: "failed" }), now)).toBe("Subagent · failed");
    expect(stateText(mkTask({ ...sub, state: "stopped", reason: "Turn ended" }), now)).toBe("Subagent · stopped (Turn ended)");
    expect(stateText(mkTask({ lastActivityAt: new Date(now - 3 * 60_000).toISOString() }), now)).toBe("No new output for 3m — may have finished");
  });

  it("row accessible name carries label, kind, state, elapsed", () => {
    expect(rowAriaLabel(mkTask({ startedAt: new Date(now - 38_000).toISOString() }), now)).toBe(
      "cargo build --release, command, running, 38s",
    );
  });
});
