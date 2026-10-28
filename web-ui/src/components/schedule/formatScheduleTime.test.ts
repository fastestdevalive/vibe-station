import { describe, expect, it } from "vitest";
import { formatClock, formatScheduleTime, isCountdown } from "./formatScheduleTime";

// Local-time constructors keep the cases timezone independent.
const now = new Date(2026, 9, 27, 12, 0, 0); // Tue Oct 27 2026, 12:00:00
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  new Date(y, mo, d, h, mi, s).toISOString();

describe("formatScheduleTime", () => {
  it("counts down under 10 minutes", () => {
    expect(formatScheduleTime(at(2026, 9, 27, 12, 4, 12), now)).toBe("in 4m 12s");
    expect(formatScheduleTime(at(2026, 9, 27, 12, 0, 30), now)).toBe("in 30s");
    expect(formatScheduleTime(at(2026, 9, 27, 12, 9, 59), now)).toBe("in 9m 59s");
  });

  it("uses Today for 10 minutes to the end of the day", () => {
    expect(formatScheduleTime(at(2026, 9, 27, 12, 10, 0), now)).toBe("Today 12:10 PM");
    expect(formatScheduleTime(at(2026, 9, 27, 15, 0), now)).toBe("Today 3:00 PM");
  });

  it("uses Tomorrow for the next calendar day, even under 24h", () => {
    expect(formatScheduleTime(at(2026, 9, 28, 9, 0), now)).toBe("Tomorrow 9:00 AM");
    expect(formatScheduleTime(at(2026, 9, 28, 11, 59), now)).toBe("Tomorrow 11:59 AM");
  });

  it("uses a weekday within 7 days", () => {
    expect(formatScheduleTime(at(2026, 9, 29, 9, 0), now)).toBe("Thu 9:00 AM");
    expect(formatScheduleTime(at(2026, 10, 2, 9, 0), now)).toBe("Mon 9:00 AM");
  });

  it("uses a date beyond 7 days", () => {
    expect(formatScheduleTime(at(2026, 10, 3, 9, 0), now)).toBe("Nov 3, 9:00 AM");
  });

  it("formats past times on an earlier day with the date, same-day past as Today", () => {
    expect(formatScheduleTime(at(2026, 9, 26, 9, 0), now)).toBe("Oct 26, 9:00 AM");
    expect(formatScheduleTime(at(2026, 9, 27, 9, 0), now)).toBe("Today 9:00 AM");
  });

  it("compares calendar days across a DST change (US 2026-11-01 fall back)", () => {
    const sat = new Date(2026, 10, 1, 0, 30); // Sun Nov 1, 00:30 local
    expect(formatScheduleTime(at(2026, 10, 2, 9, 0), sat)).toBe("Tomorrow 9:00 AM");
  });

  it("returns empty text for an invalid date", () => {
    expect(formatScheduleTime("not a date", now)).toBe("");
    expect(formatClock("not a date")).toBe("");
  });
});

describe("formatClock / isCountdown", () => {
  it("formats the clock with a plain space before AM/PM", () => {
    expect(formatClock(at(2026, 9, 27, 15, 0))).toBe("3:00 PM");
  });
  it("flags only the 0-10 minute window", () => {
    const base = now.getTime();
    expect(isCountdown(new Date(base + 60_000).toISOString(), base)).toBe(true);
    expect(isCountdown(new Date(base + 11 * 60_000).toISOString(), base)).toBe(false);
    expect(isCountdown(new Date(base - 1000).toISOString(), base)).toBe(false);
  });
});
