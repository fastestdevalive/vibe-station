import { render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkFireAt } from "@/components/chat/ScheduleSendPopover";
import { ReviewPickerWhen, describeFireTime } from "./ReviewPickerWhen";

// US DST ends 2026-11-01 02:00 PDT -> 01:00 PST: wall times 01:00-01:59 happen twice.
describe("the Fires label in the repeated DST hour (V-03)", () => {
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterEach(() => vi.useRealTimers());

  it("runs under America/Los_Angeles", () => {
    expect(new Date("2026-11-01T09:30:00Z").getHours()).toBe(1);
    expect(new Date("2026-11-01T08:30:00Z").getHours()).toBe(1);
  });

  it("clock 01:30 PST: 01:45 is scheduled as the SECOND occurrence and the label names that instant (PST, not PDT)", () => {
    vi.useFakeTimers({ now: new Date("2026-11-01T09:30:00Z") }); // 01:30 PST
    const chk = checkFireAt("2026-11-01T01:45");
    expect(chk).toEqual({ iso: "2026-11-01T09:45:00.000Z" });
    render(
      <ReviewPickerWhen when="later" onWhen={() => {}} value="2026-11-01T01:45" onValue={() => {}} min="2026-11-01T01:31" error={null} onEnter={() => {}} />,
    );
    const label = screen.getByText(/^Fires /).textContent!;
    expect(label).toContain("PST");
    expect(label).not.toContain("PDT");
    expect(label).toBe(`Fires ${describeFireTime("2026-11-01T09:45:00.000Z")}`);
  });

  it("a normal future time still names its own instant", () => {
    vi.useFakeTimers({ now: new Date("2026-10-31T12:00:00Z") });
    const chk = checkFireAt("2026-11-01T01:15");
    expect(chk).toEqual({ iso: "2026-11-01T08:15:00.000Z" }); // first occurrence, PDT
    expect(describeFireTime("2026-11-01T08:15:00.000Z")).toContain("PDT");
  });
});
