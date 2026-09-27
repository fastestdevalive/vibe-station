import { describe, expect, it } from "vitest";
import { formatTimeAgo } from "./timeAgo";

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
