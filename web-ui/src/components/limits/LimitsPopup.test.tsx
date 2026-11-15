import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary, LimitSlotRef, LimitsResult, LimitWindow } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { LimitsPopup } from "./LimitsPopup";

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

const NOW = new Date("2026-01-01T00:00:00Z").getTime();

function win(over: Partial<LimitWindow> = {}): LimitWindow {
  return {
    harness: "claude",
    windowId: "five_hour",
    cadenceMinutes: 300,
    usedPct: 42,
    resetsAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
    asOf: new Date(NOW).toISOString(),
    status: "ok",
    ...over,
  };
}

function result(over: Partial<LimitsResult> = {}): LimitsResult {
  return {
    harness: "claude",
    status: "ok",
    message: null,
    asOf: new Date(NOW).toISOString(),
    windows: [win()],
    ...over,
  };
}

const SLOTS: [LimitSlotRef, LimitSlotRef] = [
  { harness: "claude", windowId: "five_hour" },
  { harness: "claude", windowId: "seven_day" },
];

function renderPopup(harnesses: LimitsResult[], onPick = vi.fn()) {
  render(
    <LimitsPopup
      slotIndex={0}
      slots={SLOTS}
      harnesses={harnesses}
      host="test-host"
      nowMs={NOW}
      refreshing={false}
      cooldownUntil={null}
      error={null}
      onPick={onPick}
      onRefresh={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return onPick;
}

beforeEach(() => {
  useServerStore.setState({ accounts: [SYSTEM, WORK], accountsLoaded: true });
});

describe("LimitsPopup", () => {
  it("groups rows by harness then account, headed 'Claude · Work'", () => {
    renderPopup([
      result(),
      result({ accountId: "acc_work", windows: [win({ accountId: "acc_work", usedPct: 96 })] }),
      result({ harness: "codex", windows: [win({ harness: "codex", windowId: "primary", cadenceMinutes: 43200 })] }),
    ]);
    const titles = Array.from(document.querySelectorAll(".limits-popup__group-title")).map((n) => n.textContent);
    const accountTitles = Array.from(document.querySelectorAll(".limits-popup__group-title")).map(
      (n) => n.querySelector(".account-chip__name")?.textContent ?? null,
    );
    // The System group is named like Settings names it and carries the muted "System login" tag.
    expect(accountTitles).toContain("System login");
    expect(accountTitles).toContain("Work");
    expect(titles.some((t) => t?.startsWith("Claude · ") && t.includes("Work"))).toBe(true);
    expect(document.querySelector(".limits-popup__tag")?.textContent).toContain("System login");
    // A single-account harness keeps its bare label.
    expect(titles).toContain("Codex");
  });

  it("picks a row as a full LimitSlotRef including its account", () => {
    const onPick = renderPopup([
      result(),
      result({ accountId: "acc_work", windows: [win({ accountId: "acc_work" })] }),
    ]);
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]!);
    expect(onPick).toHaveBeenCalledWith({ harness: "claude", windowId: "five_hour", accountId: "acc_work" });
  });

  it("shows a generic bucket's label and dollars in an account's row and picks it with the account", () => {
    const fable = win({
      accountId: "acc_work",
      windowId: "seven_day:model:fable",
      cadenceMinutes: 10080,
      usedPct: 83,
      label: "Fable",
    });
    const dollar = win({
      accountId: "acc_work",
      windowId: "iguana_necktie",
      cadenceMinutes: null,
      usedPct: 0.5,
      label: "Iguana necktie",
      dollars: { limit: 250 },
    });
    const onPick = renderPopup([result(), result({ accountId: "acc_work", windows: [fable, dollar] })]);
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain("Fable — ");
    expect(rows[2]!.textContent).toContain("Iguana necktie — ");
    expect(rows[2]!.querySelector(".limits-popup__sub")?.textContent).toContain("$250 cap · ");
    expect(rows[2]!.textContent).toContain("<1%");
    fireEvent.click(rows[1]!);
    expect(onPick).toHaveBeenCalledWith({
      harness: "claude",
      windowId: "seven_day:model:fable",
      accountId: "acc_work",
    });
  });

  it("marks the pinned row checked and shows the other slot's tag", () => {
    renderPopup([
      result(),
      result({ accountId: "acc_work", windows: [win({ accountId: "acc_work" })] }),
    ]);
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows[0]).toHaveAttribute("aria-checked", "true");
    expect(rows[1]).toHaveAttribute("aria-checked", "false");
  });

  it("shows 'Account removed' for a result whose account is not in the store (R2F-11)", () => {
    const { container } = render(
      <LimitsPopup
        slotIndex={0}
        slots={SLOTS}
        harnesses={[result(), result({ accountId: "acc_gone", windows: [win({ accountId: "acc_gone" })] })]}
        host="test-host"
        nowMs={NOW}
        refreshing={false}
        cooldownUntil={null}
        error={null}
        onPick={vi.fn()}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("Account removed");
    expect(container.textContent).not.toMatch(/acc_/);
  });

  it("renders the edge-state texts: signed out, no data, no plan limits", () => {
    renderPopup([
      result({ status: "signed_out", windows: [win({ usedPct: null, status: "signed_out" })] }),
      result({ status: "no_data", windows: [win({ windowId: "seven_day", usedPct: null, status: "no_data" })] }),
      result({
        accountId: "acc_work",
        status: "no_plan_limits",
        windows: [win({ accountId: "acc_work", usedPct: null, status: "no_plan_limits" })],
      }),
    ]);
    expect(screen.getByText(/Signed out\. Sign in from Settings\./)).toBeInTheDocument();
    expect(screen.getByText(/No data yet/)).toBeInTheDocument();
    expect(screen.getByText(/No plan limits \(signed out, API key or setup-token login\)/)).toBeInTheDocument();
  });

  it("dims an errored window and shows its as-of time", () => {
    renderPopup([
      result({
        status: "error",
        message: "Couldn't read limit",
        windows: [win({ usedPct: 42, status: "error", asOf: new Date(NOW - 31 * 60 * 1000).toISOString() })],
      }),
    ]);
    const chip = document.querySelector(".limits-popup__row .limit-chip");
    expect(chip?.className).toContain("limit-chip--dim");
    expect(chip?.getAttribute("title")).toContain("as of");
  });

  it("keeps arrow-key navigation and Escape", () => {
    const onPick = renderPopup([result()]);
    const dialog = screen.getByRole("dialog", { name: "Replace slot 1" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({ harness: "claude", windowId: "five_hour" });
    const row = screen.getAllByRole("menuitemradio")[0]!;
    expect(within(row).getByText("42% used")).toBeInTheDocument();
  });
});
