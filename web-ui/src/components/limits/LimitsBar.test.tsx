import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary, LimitSlotRef, LimitsResult, LimitsSnapshot, LimitWindow } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { LimitsBar } from "./LimitsBar";

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => mobile.value,
  MOBILE_QUERY: "(max-width: 768px)",
}));

const mocks = vi.hoisted(() => ({
  snapshot: null as LimitsSnapshot | null,
  error: null as string | null,
  refreshing: false,
  cooldownUntil: null as number | null,
  assignSlot: vi.fn<() => Promise<void>>(),
  refresh: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/hooks/useLimits", () => {
  const defaultSlots: [LimitSlotRef, LimitSlotRef] = [
    { harness: "claude", windowId: "five_hour" },
    { harness: "claude", windowId: "seven_day" },
  ];
  return {
    useLimits: () => {
      const snap = mocks.snapshot;
      return {
        snapshot: snap,
        loading: false,
        error: mocks.error,
        refreshing: mocks.refreshing,
        cooldownUntil: mocks.cooldownUntil,
        slots: (snap?.slots ?? defaultSlots) as [LimitSlotRef, LimitSlotRef],
        windowFor: (ref: LimitSlotRef): LimitWindow | undefined =>
          snap?.harnesses
            .find((h) => h.harness === ref.harness)
            ?.windows.find((w) => w.windowId === ref.windowId),
        resultFor: (h: string): LimitsResult | undefined =>
          snap?.harnesses.find((x) => x.harness === h),
        refresh: mocks.refresh,
        assignSlot: mocks.assignSlot,
      };
    },
  };
});

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
    asOf: new Date().toISOString(),
    status: "ok",
    ...over,
  };
}

function claudeHarness(over: Partial<LimitsResult> = {}): LimitsResult {
  return {
    harness: "claude",
    status: "ok",
    message: null,
    asOf: new Date().toISOString(),
    windows: [win({ windowId: "five_hour" }), win({ windowId: "seven_day", cadenceMinutes: 10080, usedPct: 61 })],
    ...over,
  };
}

function codexHarness(over: Partial<LimitsResult> = {}): LimitsResult {
  return {
    harness: "codex",
    status: "ok",
    message: null,
    asOf: new Date().toISOString(),
    windows: [win({ harness: "codex", windowId: "primary", cadenceMinutes: 43200, usedPct: 4 })],
    ...over,
  };
}

function agyHarness(over: Partial<LimitsResult> = {}): LimitsResult {
  return {
    harness: "agy",
    status: "ok",
    message: null,
    asOf: new Date().toISOString(),
    windows: [win({ harness: "agy", windowId: "gemini_5h", cadenceMinutes: 300, usedPct: 12 })],
    ...over,
  };
}

function snapshot(over: Partial<LimitsSnapshot> = {}): LimitsSnapshot {
  return { host: "test-host", slots: SLOTS, harnesses: [claudeHarness(), codexHarness()], ...over };
}

function acct(over: Partial<AccountSummary> & Pick<AccountSummary, "id" | "cli">): AccountSummary {
  return {
    label: null,
    displayName: over.id,
    email: null,
    plan: null,
    method: "sign_in",
    auth: "signed_in",
    isDefault: false,
    limited: null,
    createdAt: null,
    ...over,
  };
}

const SYSTEM = acct({ id: "system", cli: "claude", displayName: "System login", method: "system", isDefault: true });
const WORK = acct({ id: "acc_work", cli: "claude", displayName: "Work" });

beforeEach(() => {
  mobile.value = false;
  useServerStore.setState({ accounts: [SYSTEM, WORK], accountsLoaded: true });
  mocks.snapshot = snapshot();
  mocks.error = null;
  mocks.refreshing = false;
  mocks.cooldownUntil = null;
  mocks.assignSlot.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function chipButtons(): [HTMLElement, HTMLElement] {
  return screen
    .getAllByRole("button")
    .filter((b) => (b.getAttribute("aria-label") ?? "").startsWith("Slot ")) as [HTMLElement, HTMLElement];
}

describe("LimitsBar", () => {
  it("renders the two chips in slot order", () => {
    render(<LimitsBar />);
    const chips = chipButtons();
    expect(chips).toHaveLength(2);
    expect(chips[0].getAttribute("aria-label")).toContain("Slot 1");
    expect(chips[1].getAttribute("aria-label")).toContain("Slot 2");
  });

  it("renders nothing before any snapshot or error (no layout jump)", () => {
    mocks.snapshot = null;
    mocks.error = null;
    const { container } = render(<LimitsBar />);
    expect(container.firstChild).toBeNull();
  });

  it("opens a popup listing the Claude then Codex groups with the host name", () => {
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    const dialog = screen.getByRole("dialog", { name: "Replace slot 2" });
    expect(within(dialog).getByText(/Replace slot 2 · test-host/)).toBeInTheDocument();
    const titles = Array.from(dialog.querySelectorAll(".limits-popup__group-title")).map((n) => n.textContent);
    // [header, "Claude", "Codex"]
    const groupTitles = titles.filter((t) => t === "Claude" || t === "Codex");
    expect(groupTitles).toEqual(["Claude", "Codex"]);
  });

  it("moves the roving cursor with arrows and picks a Codex row on Enter", () => {
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    const dialog = screen.getByRole("dialog");
    // Rows: [claude/five_hour, claude/seven_day, codex/primary]. Initial cursor
    // is slot 2's current window (claude/seven_day); ArrowDown moves to
    // codex/primary, Enter picks it.
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(mocks.assignSlot).toHaveBeenCalledTimes(1);
    expect(mocks.assignSlot).toHaveBeenCalledWith(1, { harness: "codex", windowId: "primary" });
  });

  it("calls assignSlot once when picking the other slot's limit (swap via nextSlots)", () => {
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    const dialog = screen.getByRole("dialog");
    // The slot-1 limit (claude/five_hour) is a row in the slot-2 popup.
    const row = within(dialog).getByText("slot 1");
    fireEvent.click(row.closest('[role="menuitemradio"]')!);
    expect(mocks.assignSlot).toHaveBeenCalledTimes(1);
    expect(mocks.assignSlot).toHaveBeenCalledWith(1, { harness: "claude", windowId: "five_hour" });
  });

  it("closes on Escape and returns focus to the tapped chip", () => {
    render(<LimitsBar />);
    const chip = chipButtons()[1];
    fireEvent.click(chip);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(chip);
  });

  it("closes on outside mousedown", () => {
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables Refresh while refreshing", () => {
    mocks.refreshing = true;
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    const refresh = screen.getByRole("button", { name: /Refreshing/ });
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Refresh during the cooldown window", () => {
    mocks.cooldownUntil = Date.now() + 5000;
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    const refresh = screen.getByRole("button", { name: /Wait/ });
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows Signed out for a signed-out harness group", () => {
    mocks.snapshot = snapshot({ harnesses: [claudeHarness(), codexHarness({ status: "signed_out", windows: [] })] });
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    expect(screen.getByText("Signed out. Sign in from Settings.")).toBeInTheDocument();
  });

  it("renders an agy harness group with a window label row", () => {
    mocks.snapshot = snapshot({ harnesses: [claudeHarness(), codexHarness(), agyHarness()] });
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    const dialog = screen.getByRole("dialog");
    const titles = Array.from(dialog.querySelectorAll(".limits-popup__group-title")).map((n) => n.textContent);
    expect(titles).toContain("Agy");
    expect(within(dialog).getByText(/Gemini · 5h/)).toBeInTheDocument();
  });

  it("puts the absolute reset time on its own subtitle line under the countdown", () => {
    const resetsAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    mocks.snapshot = snapshot({
      harnesses: [
        claudeHarness(),
        codexHarness(),
        agyHarness({
          windows: [
            win({ harness: "agy", windowId: "gemini_5h", cadenceMinutes: 300, usedPct: 12, resetsAt }),
          ],
        }),
      ],
    });
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    const dialog = screen.getByRole("dialog");
    const row = within(dialog).getByText(/Gemini · 5h/).closest('[role="menuitemradio"]')!;
    const main = row.querySelector(".limits-popup__main")!;
    const sub = row.querySelector(".limits-popup__sub")!;
    expect(main.textContent).toMatch(/^Gemini · 5h — resets in /);
    expect(main.textContent).not.toMatch(/\(/);
    expect(sub.textContent).toBeTruthy();
  });

  it("shows Signed out on the labelled placeholder rows when agy is signed out", () => {
    const placeholder = (windowId: string, cadenceMinutes: number) =>
      win({ harness: "agy", windowId, cadenceMinutes, usedPct: null, resetsAt: null, status: "signed_out" });
    mocks.snapshot = snapshot({
      harnesses: [
        claudeHarness(),
        codexHarness(),
        agyHarness({
          status: "signed_out",
          windows: [placeholder("gemini_5h", 300), placeholder("gemini_weekly", 10080)],
        }),
      ],
    });
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Gemini · 5h — Signed out. Sign in from Settings.")).toBeInTheDocument();
    expect(within(dialog).getByText("Gemini · weekly — Signed out. Sign in from Settings.")).toBeInTheDocument();
  });

  it("picks an agy row via assignSlot with the agy ref", () => {
    mocks.snapshot = snapshot({ harnesses: [claudeHarness(), codexHarness(), agyHarness()] });
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    const dialog = screen.getByRole("dialog");
    const row = within(dialog).getByText(/Gemini · 5h/).closest('[role="menuitemradio"]')!;
    fireEvent.click(row);
    expect(mocks.assignSlot).toHaveBeenCalledTimes(1);
    expect(mocks.assignSlot).toHaveBeenCalledWith(1, { harness: "agy", windowId: "gemini_5h" });
  });

  // ── Per-account footer chips (plan B3.9) ────────────────────────────────
  it("shows an account mark on a slot only when the harness has several accounts", () => {
    mocks.snapshot = snapshot({
      slots: [
        { harness: "claude", windowId: "five_hour", accountId: "acc_work" },
        { harness: "claude", windowId: "seven_day" },
      ],
    });
    render(<LimitsBar />);
    const chips = chipButtons();
    expect(chips[0].querySelector(".account-chip--mark")).toHaveAttribute("aria-label", "Account: Work");
    // The System login is named like Settings names it, not "System".
    expect(chips[1].querySelector(".account-chip--mark")).toHaveAttribute("aria-label", "Account: System login");
  });

  it("hides the account suffix for a single-account CLI", () => {
    useServerStore.setState({ accounts: [SYSTEM] });
    mocks.snapshot = snapshot({
      slots: [
        { harness: "claude", windowId: "five_hour", accountId: "acc_work" },
        { harness: "claude", windowId: "seven_day" },
      ],
    });
    render(<LimitsBar />);
    for (const chip of chipButtons()) {
      expect(chip.querySelector(".account-chip")).toBeNull();
    }
  });

  it("keys chips by the full slot (account included)", () => {
    mocks.snapshot = snapshot({
      slots: [
        { harness: "claude", windowId: "five_hour", accountId: "acc_work" },
        { harness: "claude", windowId: "five_hour" },
      ],
    });
    render(<LimitsBar />);
    // Both slots survive as distinct chips (React would drop a duplicate key).
    expect(chipButtons()).toHaveLength(2);
  });

  it("renders the popup as a bottom sheet with a backdrop on phones", () => {
    mobile.value = true;
    render(<LimitsBar />);
    fireEvent.click(chipButtons()[1]);
    expect(document.querySelector(".limits-popup-backdrop")).not.toBeNull();
    expect(screen.getByRole("dialog")).toHaveClass("limits-popup");
  });

  it("renders the chips when the first snapshot arrives after an empty first render", () => {
    mocks.snapshot = null;
    mocks.error = null;
    const { container, rerender } = render(<LimitsBar />);
    expect(container.firstChild).toBeNull();
    mocks.snapshot = snapshot();
    expect(() => rerender(<LimitsBar />)).not.toThrow();
    expect(chipButtons()).toHaveLength(2);
  });

  it("renders two identical slots as two chips without a duplicate-key warning", () => {
    const same: LimitSlotRef = { harness: "claude", windowId: "five_hour" };
    mocks.snapshot = snapshot({ slots: [same, { ...same }] });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<LimitsBar />);
    expect(chipButtons()).toHaveLength(2);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
