import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkFireAt } from "./ScheduleSendPopover";

describe("checkFireAt — DST repeated hour", () => {
  const realTz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "America/Los_Angeles";
    // 01:38:30 PDT, the first pass through the repeated 01:00-02:00 hour on 2026-11-01.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T08:38:30Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  it("accepts a wall time whose first occurrence is past but whose second is in the future", () => {
    expect(checkFireAt("2026-11-01T01:38")).toEqual({ iso: "2026-11-01T09:38:00.000Z" });
  });

  it("still rejects a wall time that is past in every occurrence", () => {
    expect(checkFireAt("2026-11-01T00:30")).toEqual({ error: "Pick a time in the future." });
  });

  it("keeps a plain future time and rejects empty input", () => {
    expect(checkFireAt("2026-11-02T10:00")).toEqual({ iso: "2026-11-02T18:00:00.000Z" });
    expect(checkFireAt("")).toEqual({ error: "Pick a date and time." });
  });
});

describe("checkFireAt — invalid values", () => {
  it("reports unparsable and out-of-range years as invalid, not as past", () => {
    for (const v of ["2026-13-45T10:00", "garbage", "+012026-01-01T10:00", "12026-01-01T10:00"]) {
      expect(checkFireAt(v), v).toEqual({ error: "Pick a valid date and time." });
    }
  });

  it("reports a real past instant as past", () => {
    expect(checkFireAt("2001-01-01T10:00")).toEqual({ error: "Pick a time in the future." });
  });
});
