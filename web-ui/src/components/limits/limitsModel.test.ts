import { describe, expect, it } from "vitest";
import type { LimitSlotRef, LimitWindow } from "@/api/types";
import {
  ariaLabel,
  cadenceBadge,
  cadenceLabel,
  chipView,
  compactResetCountdown,
  formatLocalResetTime,
  harnessLabel,
  nextSlots,
  resetCountdown,
  sameRef,
  statusReason,
} from "./limitsModel";

const SLOTS: [LimitSlotRef, LimitSlotRef] = [
  { harness: "claude", windowId: "five_hour" },
  { harness: "claude", windowId: "seven_day" },
];

function win(over: Partial<LimitWindow> = {}): LimitWindow {
  return {
    harness: "claude",
    windowId: "five_hour",
    cadenceMinutes: 300,
    usedPct: 42,
    resetsAt: null,
    asOf: new Date(0).toISOString(),
    status: "ok",
    ...over,
  };
}

describe("sameRef", () => {
  it("matches equal refs", () => {
    expect(sameRef({ harness: "claude", windowId: "five_hour" }, { harness: "claude", windowId: "five_hour" })).toBe(true);
    expect(sameRef({ harness: "claude", windowId: "five_hour" }, { harness: "claude", windowId: "seven_day" })).toBe(false);
  });
});

describe("nextSlots", () => {
  it("no-op when picking the current slot", () => {
    expect(nextSlots(SLOTS, 0, SLOTS[0])).toBe(SLOTS);
  });
  it("swaps when picking the other slot", () => {
    expect(nextSlots(SLOTS, 0, SLOTS[1])).toEqual([SLOTS[1], SLOTS[0]]);
    expect(nextSlots(SLOTS, 1, SLOTS[0])).toEqual([SLOTS[1], SLOTS[0]]);
  });
  it("replaces slotIndex only otherwise", () => {
    const picked: LimitSlotRef = { harness: "codex", windowId: "primary" };
    expect(nextSlots(SLOTS, 1, picked)).toEqual([SLOTS[0], picked]);
    expect(nextSlots(SLOTS, 0, picked)).toEqual([picked, SLOTS[1]]);
  });
});

describe("cadenceLabel", () => {
  it.each([
    [300, "Rolling hours"],
    [10080, "wk"],
    [43200, "mo"],
    [1440, "1d"],
    [4320, "3d"],
    [null, "limit"],
    [45, "45m"],
  ] as const)("cadenceLabel(%s) === %s", (mins, expected) => {
    expect(cadenceLabel(mins)).toBe(expected);
  });
});

describe("cadenceBadge", () => {
  it.each([
    [300, "hr"],
    [10080, "wk"],
    [43200, "mo"],
    [null, ""],
  ] as const)("cadenceBadge(%s) === %s", (mins, expected) => {
    expect(cadenceBadge(mins)).toBe(expected);
  });
});

describe("resetCountdown", () => {
  it("null → —", () => {
    expect(resetCountdown(null, 0)).toBe("—");
  });
  it("past → reset", () => {
    expect(resetCountdown(new Date(1000).toISOString(), 2000)).toBe("reset");
  });
  it("130 min → resets in 2h 10m", () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    const target = now + 130 * 60 * 1000;
    expect(resetCountdown(new Date(target).toISOString(), now)).toBe("resets in 2h 10m");
  });
});

describe("compactResetCountdown", () => {
  it("null → empty", () => {
    expect(compactResetCountdown(null, 0)).toBe("");
  });
  it("past → reset", () => {
    expect(compactResetCountdown(new Date(1000).toISOString(), 2000)).toBe("reset");
  });
  it("15 min → ↻ 15m", () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    const target = now + 15 * 60 * 1000;
    expect(compactResetCountdown(new Date(target).toISOString(), now)).toBe("↻ 15m");
  });
  it("130 min → ↻ 2h 10m", () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    const target = now + 130 * 60 * 1000;
    expect(compactResetCountdown(new Date(target).toISOString(), now)).toBe("↻ 2h 10m");
  });
  it("120 min (exact hour) → ↻ 2h", () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    const target = now + 120 * 60 * 1000;
    expect(compactResetCountdown(new Date(target).toISOString(), now)).toBe("↻ 2h");
  });
  it("3 days → ↻ 3d", () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    const target = now + 3 * 24 * 60 * 60 * 1000;
    expect(compactResetCountdown(new Date(target).toISOString(), now)).toBe("↻ 3d");
  });
});

describe("formatLocalResetTime", () => {
  it("null or invalid or past → null", () => {
    expect(formatLocalResetTime(null, 0)).toBeNull();
    expect(formatLocalResetTime("not-a-date", 0)).toBeNull();
    expect(formatLocalResetTime(new Date(1000).toISOString(), 2000)).toBeNull();
  });

  it("same calendar day → local time string", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const target = new Date(2026, 0, 1, 14, 30, 0);
    const result = formatLocalResetTime(target.toISOString(), now);
    const expected = target.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(result).toBe(expected);
  });

  it("within 6 days → weekday + time", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const target = new Date(2026, 0, 3, 14, 30, 0);
    const result = formatLocalResetTime(target.toISOString(), now);
    const weekday = target.toLocaleDateString([], { weekday: "short" });
    const time = target.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(result).toBe(`${weekday} ${time}`);
  });

  it("further out (>= 6 days) → month + day + time", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const target = new Date(2026, 0, 20, 14, 30, 0);
    const result = formatLocalResetTime(target.toISOString(), now);
    const dateStr = target.toLocaleDateString([], { month: "short", day: "numeric" });
    const time = target.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(result).toBe(`${dateStr}, ${time}`);
  });
});

describe("chipView", () => {
  it("null usedPct → nodata with — (never 0%)", () => {
    const v = chipView(win({ usedPct: null }), 0);
    expect(v.kind).toBe("nodata");
    expect(v.pctText).toBe("—");
    expect(v.pct).toBeNull();
  });
  it("no window → nodata", () => {
    const v = chipView(undefined, 0);
    expect(v.kind).toBe("nodata");
    expect(v.pctText).toBe("—");
  });
  it("past resetsAt → reset", () => {
    const v = chipView(win({ usedPct: 42, resetsAt: new Date(1000).toISOString() }), 2000);
    expect(v.kind).toBe("reset");
    expect(v.pctText).toBe("reset");
  });
  it("usedPct 100 → limit", () => {
    const v = chipView(win({ usedPct: 100 }), 0);
    expect(v.kind).toBe("limit");
    expect(v.pctText).toBe("100%");
  });
  it("usedPct 90 → warn with ! glyph", () => {
    const v = chipView(win({ usedPct: 90 }), 0);
    expect(v.kind).toBe("warn");
    expect(v.glyph).toBe("!");
    expect(v.pctText).toBe("90%");
  });
  it("asOf 31 min old → dim with asOfLabel", () => {
    const now = 31 * 60 * 1000;
    const v = chipView(win({ usedPct: 42, asOf: new Date(0).toISOString() }), now);
    expect(v.dim).toBe(true);
    expect(v.asOfLabel).toBeTruthy();
  });
  it("status error with value → dim + reason", () => {
    const v = chipView(win({ usedPct: 42, status: "error" }), 0);
    expect(v.dim).toBe(true);
    expect(v.reason).toBeTruthy();
  });
});

describe("harnessLabel", () => {
  it("maps claude/codex and capitalises others", () => {
    expect(harnessLabel("claude")).toBe("Claude");
    expect(harnessLabel("codex")).toBe("Codex");
    expect(harnessLabel("opencode")).toBe("Opencode");
  });
});

describe("statusReason", () => {
  it("ok → null; others map", () => {
    expect(statusReason("ok", null)).toBeNull();
    expect(statusReason("not_installed", null)).toBe("Not installed");
    expect(statusReason("signed_out", null)).toBe("Signed out");
    expect(statusReason("no_plan_limits", null)).toContain("No plan limits");
    expect(statusReason("no_data", null)).toBe("No data yet");
    expect(statusReason("error", "boom")).toBe("boom");
    expect(statusReason("error", null)).toBe("Couldn't read limit");
    expect(statusReason("unsupported", null)).toBe("Not supported");
  });
});

describe("ariaLabel", () => {
  it("includes harness, window, percent, reset", () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    const w = win({ usedPct: 42, resetsAt: new Date(now + 130 * 60 * 1000).toISOString() });
    const v = chipView(w, now);
    const label = ariaLabel("claude", w, v, now);
    expect(label).toContain("Claude");
    expect(label).toContain("five hour limit");
    expect(label).toContain("42 percent used");
    expect(label).toContain("resets");
  });
});
