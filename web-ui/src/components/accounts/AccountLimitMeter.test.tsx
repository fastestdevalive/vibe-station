import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LimitWindow, LimitsResult } from "@/api/types";
import { AccountLimitMeter } from "./AccountLimitMeter";

const limits = vi.hoisted(() => ({ result: undefined as unknown, calls: [] as unknown[][] }));
vi.mock("@/hooks/useLimits", () => ({
  useLimits: () => ({
    resultFor: (...args: unknown[]) => {
      limits.calls.push(args);
      return limits.result;
    },
  }),
}));

function win(windowId: string, cadenceMinutes: number | null, usedPct: number | null): LimitWindow {
  return { harness: "claude", windowId, cadenceMinutes, usedPct, resetsAt: null, asOf: "2026-01-01T00:00:00Z", status: "ok" };
}

function setResult(windows: LimitWindow[]) {
  limits.result = { harness: "claude", status: "ok", message: null, asOf: "", windows } satisfies LimitsResult;
}

beforeEach(() => {
  limits.result = undefined;
  limits.calls = [];
});

describe("AccountLimitMeter", () => {
  it("renders one meter per window with the right value", () => {
    setResult([win("five_hour", 300, 12), win("seven_day", 10080, 56)]);
    render(<AccountLimitMeter cli="claude" accountId="acc_1" />);
    const meters = screen.getAllByRole("meter");
    expect(meters).toHaveLength(2);
    expect(meters[0]).toHaveAttribute("aria-valuenow", "12");
    expect(meters[0]).toHaveAttribute("aria-label", "5h 12% used");
    expect(meters[1]).toHaveAttribute("aria-valuenow", "56");
    expect(meters[1]).toHaveAttribute("aria-label", "wk 56% used");
    expect(limits.calls[0]).toEqual(["claude", "acc_1"]);
  });

  it("renders nothing without numeric data", () => {
    setResult([win("five_hour", 300, null)]);
    const { container } = render(<AccountLimitMeter cli="claude" accountId="acc_1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without a result and resolves the System login without an id", () => {
    const { container } = render(<AccountLimitMeter cli="claude" accountId="system" />);
    expect(container).toBeEmptyDOMElement();
    expect(limits.calls[0]).toEqual(["claude", undefined]);
  });

  it("marks 96% as warn and 100% as danger", () => {
    setResult([win("five_hour", 300, 96), win("seven_day", 10080, 100)]);
    const { container } = render(<AccountLimitMeter cli="claude" accountId="acc_1" />);
    expect(container.querySelector(".account-meter__fill--warn")).not.toBeNull();
    expect(container.querySelector(".account-meter__fill--danger")).not.toBeNull();
  });

  it("compact shows only the highest window", () => {
    setResult([win("five_hour", 300, 12), win("seven_day", 10080, 56)]);
    render(<AccountLimitMeter cli="claude" accountId="acc_1" compact />);
    const meters = screen.getAllByRole("meter");
    expect(meters).toHaveLength(1);
    expect(meters[0]).toHaveAttribute("aria-valuenow", "56");
  });
});
