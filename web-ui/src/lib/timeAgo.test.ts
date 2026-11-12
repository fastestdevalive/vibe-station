import { describe, expect, it } from "vitest";
import {
  formatFullTimestamp,
  formatOutlineSpokenTime,
  formatOutlineTime,
  formatOutlineTitle,
  formatTimeAgo,
} from "./timeAgo";

describe("formatTimeAgo", () => {
  const base = new Date("2026-09-27T12:00:00.000Z").getTime();

  it("handles null / undefined / invalid inputs", () => {
    expect(formatTimeAgo(null, base)).toBe("");
    expect(formatTimeAgo(undefined, base)).toBe("");
    expect(formatTimeAgo("", base)).toBe("");
    expect(formatTimeAgo("invalid-date", base)).toBe("");
  });

  it("formats seconds ago as now", () => {
    expect(formatTimeAgo(new Date(base - 10_000), base)).toBe("now");
    expect(formatTimeAgo(new Date(base - 59_000), base)).toBe("now");
  });

  it("formats minutes ago", () => {
    expect(formatTimeAgo(new Date(base - 60_000), base)).toBe("1m");
    expect(formatTimeAgo(new Date(base - 5 * 60_000), base)).toBe("5m");
    expect(formatTimeAgo(new Date(base - 59 * 60_000), base)).toBe("59m");
  });

  it("formats hours ago", () => {
    expect(formatTimeAgo(new Date(base - 60 * 60_000), base)).toBe("1h");
    expect(formatTimeAgo(new Date(base - 23 * 3600_000), base)).toBe("23h");
  });

  it("formats days ago", () => {
    expect(formatTimeAgo(new Date(base - 24 * 3600_000), base)).toBe("1d");
    expect(formatTimeAgo(new Date(base - 2 * 24 * 3600_000), base)).toBe("2d");
    expect(formatTimeAgo(new Date(base - 6 * 24 * 3600_000), base)).toBe("6d");
  });

  it("formats weeks ago", () => {
    expect(formatTimeAgo(new Date(base - 7 * 24 * 3600_000), base)).toBe("1w");
    expect(formatTimeAgo(new Date(base - 14 * 24 * 3600_000), base)).toBe("2w");
  });

  it("formats months ago", () => {
    expect(formatTimeAgo(new Date(base - 35 * 24 * 3600_000), base)).toBe("1mo");
    expect(formatTimeAgo(new Date(base - 65 * 24 * 3600_000), base)).toBe("2mo");
  });

  it("formats years ago", () => {
    expect(formatTimeAgo(new Date(base - 400 * 24 * 3600_000), base)).toBe("1y");
  });
});

describe("formatFullTimestamp (4.T2)", () => {
  it("formats a local time as 'Tue 20 Oct 2026, 23:44'", () => {
    expect(formatFullTimestamp("2026-10-20T23:44:00")).toBe("Tue 20 Oct 2026, 23:44");
  });

  it("returns '' for invalid or missing input", () => {
    expect(formatFullTimestamp("garbage")).toBe("");
    expect(formatFullTimestamp(null)).toBe("");
    expect(formatFullTimestamp(undefined)).toBe("");
  });
});

/** ICU may put a narrow no-break space before AM/PM; compare on plain spaces. */
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

describe("formatOutlineTime", () => {
  // Local wall-clock times, so the results do not depend on the test machine's zone.
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const us = (ts: string, parentTs?: string, at = now) => plain(formatOutlineTime(ts, at, parentTs, "en-US"));

  it("is relative under a day: now / Nm / Nh", () => {
    expect(us(ago(59_000))).toBe("now");
    expect(us(ago(60_000))).toBe("1m");
    expect(us(ago(59 * 60_000))).toBe("59m");
    expect(us(ago(60 * 60_000))).toBe("1h");
    expect(us(ago(23 * 3600_000 + 59 * 60_000))).toBe("23h");
  });

  it("is absolute from 24h, with the time this year and the year otherwise", () => {
    expect(us(ago(24 * 3600_000))).toBe("Nov 11, 3:00 PM");
    expect(us(new Date(2026, 0, 3, 9, 5).toISOString())).toBe("Jan 3, 9:05 AM");
    const newYear = new Date(2027, 0, 2, 10, 0).getTime();
    expect(us(new Date(2026, 11, 31, 10, 0).toISOString(), undefined, newYear)).toBe("Dec 31, 2026");
  });

  it("a beat on its old turn's calendar day shows only the time", () => {
    const turn = new Date(2026, 10, 10, 9, 0).toISOString();
    expect(us(new Date(2026, 10, 10, 15, 42).toISOString(), turn)).toBe("3:42 PM");
    // Another day than its turn: the full date
    expect(us(new Date(2026, 10, 11, 0, 30).toISOString(), turn)).toBe("Nov 11, 12:30 AM");
    // A turn under a day old keeps its beats relative
    expect(us(ago(5 * 60_000), ago(10 * 60_000))).toBe("5m");
  });

  it("follows the locale's 12/24h convention and order", () => {
    const ts = new Date(2026, 10, 11, 15, 0).toISOString();
    expect(plain(formatOutlineTime(ts, now, undefined, "en-GB"))).toBe("11 Nov, 15:00");
    expect(plain(formatOutlineTime(ts, now, new Date(2026, 10, 11, 8, 0).toISOString(), "en-GB"))).toBe("15:00");
  });

  it("renders nothing for missing or invalid input", () => {
    expect(formatOutlineTime(undefined, now)).toBe("");
    expect(formatOutlineTime("", now)).toBe("");
    expect(formatOutlineTime("garbage", now)).toBe("");
  });
});

describe("formatOutlineTitle / formatOutlineSpokenTime", () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime();

  it("titles in the same locale as the label, without seconds", () => {
    expect(plain(formatOutlineTitle(new Date(2026, 10, 11, 15, 0, 42).toISOString(), "en-US"))).toBe("Wed, Nov 11, 2026, 3:00 PM");
    expect(plain(formatOutlineTitle(new Date(2026, 10, 11, 15, 0).toISOString(), "en-GB"))).toBe("Wed, 11 Nov 2026, 15:00");
    expect(formatOutlineTitle("garbage")).toBe("");
  });

  it("speaks the age", () => {
    const spoken = (ms: number) => formatOutlineSpokenTime(new Date(now - ms).toISOString(), now, "en-US");
    expect(spoken(30_000)).toBe("now");
    expect(spoken(5 * 60_000)).toBe("5 minutes ago");
    expect(spoken(2 * 3600_000)).toBe("2 hours ago");
    expect(spoken(24 * 3600_000)).toBe("yesterday");
    expect(plain(spoken(10 * 24 * 3600_000))).toBe("Mon, Nov 2, 2026, 3:00 PM");
    expect(formatOutlineSpokenTime(undefined, now)).toBe("");
  });
});
