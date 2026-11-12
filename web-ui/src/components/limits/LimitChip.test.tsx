import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LimitWindow } from "@/api/types";
import type { AccountSummary } from "@/api/types";
import { LimitChip } from "./LimitChip";

function win(over: Partial<LimitWindow> = {}): LimitWindow {
  return {
    harness: "claude",
    windowId: "five_hour",
    cadenceMinutes: 300,
    usedPct: 42,
    resetsAt: null,
    asOf: new Date().toISOString(),
    status: "ok",
    ...over,
  };
}

const NOW = new Date("2026-01-01T00:00:00Z").getTime();

describe("LimitChip", () => {
  it("renders percent, cadence badge, imminent countdown and an accessible label", () => {
    const w = win({ usedPct: 42, resetsAt: new Date(NOW + 130 * 60 * 1000).toISOString() });
    render(<LimitChip harness="claude" window={w} nowMs={NOW} variant="bar" />);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("hr")).toBeInTheDocument();
    expect(screen.getByText("↻ 2h 10m")).toBeInTheDocument();
    const label = screen.getByRole("button").getAttribute("aria-label") ?? "";
    expect(label).toContain("Claude");
    expect(label).toContain("42 percent");
    expect(label).toContain("resets");
  });

  it("renders 'used' suffix in row variant but omits it in bar variant", () => {
    const w = win({ usedPct: 42 });
    const { unmount } = render(<LimitChip harness="claude" window={w} nowMs={NOW} variant="row" />);
    expect(screen.getByText("42% used")).toBeInTheDocument();
    unmount();
    render(<LimitChip harness="claude" window={w} nowMs={NOW} variant="bar" />);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.queryByText("42% used")).not.toBeInTheDocument();
  });

  it("does not append 'used' when row variant is in reset state", () => {
    const w = win({ usedPct: 42, resetsAt: new Date(NOW - 1000).toISOString() });
    render(<LimitChip harness="claude" window={w} nowMs={NOW} variant="row" />);
    expect(screen.getByText("reset")).toBeInTheDocument();
    expect(screen.queryByText("reset used")).not.toBeInTheDocument();
  });

  it("tooltip shows a real countdown, not a bogus huge one", () => {
    const w = win({ resetsAt: new Date(NOW + 130 * 60 * 1000).toISOString() });
    render(<LimitChip harness="claude" window={w} nowMs={NOW} variant="bar" />);
    expect(screen.getByRole("button").getAttribute("title")).toBe("Resets in 2h 10m");
  });

  it("keeps the cadence visible for a known window with no data", () => {
    const w = win({ usedPct: null, status: "error" });
    render(<LimitChip harness="claude" window={w} nowMs={NOW} variant="bar" />);
    expect(screen.getByText("hr")).toBeInTheDocument();
  });

  it("derives the cadence from the slot's window id when there is no window", () => {
    render(<LimitChip harness="claude" window={undefined} fallbackWindowId="seven_day" nowMs={NOW} variant="bar" />);
    expect(screen.getByText("wk")).toBeInTheDocument();
  });

  it("shows — and never 0% for an undefined window", () => {
    render(<LimitChip harness="claude" window={undefined} nowMs={NOW} variant="bar" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("shows a warn glyph and class at 95%", () => {
    render(<LimitChip harness="claude" window={win({ usedPct: 95 })} nowMs={NOW} variant="bar" />);
    expect(screen.getByText("!")).toBeInTheDocument();
    expect(screen.getByRole("button").className).toContain("limit-chip--warn");
  });

  it("reports limit reached and uses the limit class at 100%", () => {
    render(<LimitChip harness="claude" window={win({ usedPct: 100 })} nowMs={NOW} variant="bar" />);
    const label = screen.getByRole("button").getAttribute("aria-label") ?? "";
    expect(label).toContain("limit reached");
    expect(screen.getByRole("button").className).toContain("limit-chip--limit");
  });

  it("shows reset when resetsAt is in the past", () => {
    const w = win({ usedPct: 42, resetsAt: new Date(NOW - 1000).toISOString() });
    render(<LimitChip harness="claude" window={w} nowMs={NOW} variant="bar" />);
    expect(screen.getByText("reset")).toBeInTheDocument();
  });

  it("dims and notes as-of when the value is stale", () => {
    const staleAsOf = new Date(NOW - 31 * 60 * 1000).toISOString();
    const w = win({ usedPct: 42, asOf: staleAsOf });
    render(<LimitChip harness="claude" window={w} nowMs={NOW} variant="bar" />);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("limit-chip--dim");
    expect(btn.getAttribute("title") ?? "").toContain("as of");
  });
});

const WORK_ACCOUNT: AccountSummary = {
  id: "acc_work",
  cli: "claude",
  label: null,
  displayName: "Work",
  email: null,
  plan: null,
  method: "sign_in",
  auth: "signed_in",
  isDefault: false,
  limited: null,
  createdAt: null,
};

describe("LimitChip per-account mark (R1F-14)", () => {
  it("shows the account mark after the percentage when the caller passes one", () => {
    const w = win({ usedPct: 42 });
    const { unmount } = render(
      <LimitChip harness="claude" window={w} nowMs={NOW} variant="bar" account={WORK_ACCOUNT} />,
    );
    const mark = document.querySelector(".account-chip--mark");
    expect(mark).toHaveAttribute("aria-label", "Account: Work");
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Work");
    expect(screen.getByRole("button").getAttribute("title")).toContain("Work");
    unmount();

    render(<LimitChip harness="claude" window={w} nowMs={NOW} variant="bar" />);
    expect(document.querySelector(".account-chip")).toBeNull();
  });
});
