import { useEffect } from "react";
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { api } from "@/api";
import type {
  LimitSlotRef,
  LimitsResult,
  LimitsSnapshot,
  LimitWindow,
} from "@/api/types";
import { nextSlots, type SlotIndex } from "@/components/limits/limitsModel";

export const DEFAULT_SLOTS: [LimitSlotRef, LimitSlotRef] = [
  { harness: "claude", windowId: "five_hour" },
  { harness: "claude", windowId: "seven_day" },
];

interface LimitsState {
  snapshot: LimitsSnapshot | null;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  cooldownUntil: number | null;
}

export const useLimitsStore: UseBoundStore<StoreApi<LimitsState>> = create<LimitsState>(() => ({
  snapshot: null,
  loading: false,
  error: null,
  refreshing: false,
  cooldownUntil: null,
}));

/** Copy of the boot singleton pattern in useMarkdownStyle.ts: one GET seed and
 *  one `limits:updated` + `ws:open` subscription shared by all consumers. */
let booted = false;
let bootOff: (() => void) | null = null;

async function refetch(): Promise<void> {
  try {
    const snapshot = await api.getLimits();
    useLimitsStore.setState({ snapshot, error: null });
  } catch {
    useLimitsStore.setState({ error: "Couldn't load limits" });
  }
}

function boot(): void {
  if (booted) return;
  booted = true;

  useLimitsStore.setState({ loading: true });
  void refetch().finally(() => {
    useLimitsStore.setState({ loading: false });
  });

  const offUpdated = api.on("limits:updated", (ev) => {
    if (ev.type !== "limits:updated") return;
    useLimitsStore.setState({ snapshot: ev.limits });
  });
  const offOpen = api.on("ws:open", () => {
    void refetch();
  });
  bootOff = () => {
    offUpdated();
    offOpen();
  };
}

export interface UseLimitsResult extends LimitsState {
  slots: [LimitSlotRef, LimitSlotRef];
  /** The window for a pinned slot, matching harness + window + account
   *  (`accountId` absent = the CLI's System login). */
  windowFor(ref: LimitSlotRef): LimitWindow | undefined;
  /** The harness result for one account (`accountId` absent = System login). */
  resultFor(harness: string, accountId?: string): LimitsResult | undefined;
  refresh(): Promise<void>;
  assignSlot(slotIndex: SlotIndex, picked: LimitSlotRef): Promise<void>;
}

/** Limits carry an account id only for NON-System accounts; `"system"`/empty/
 *  absent all mean the CLI's System login (mirror of `normalize_account_id`). */
function limitAccountOf(accountId: string | null | undefined): string | null {
  return !accountId || accountId === "system" ? null : accountId;
}

export function useLimits(): UseLimitsResult {
  useEffect(() => {
    boot();
  }, []);

  const snapshot = useLimitsStore((s) => s.snapshot);
  const loading = useLimitsStore((s) => s.loading);
  const error = useLimitsStore((s) => s.error);
  const refreshing = useLimitsStore((s) => s.refreshing);
  const cooldownUntil = useLimitsStore((s) => s.cooldownUntil);

  const slots: [LimitSlotRef, LimitSlotRef] = snapshot?.slots ?? DEFAULT_SLOTS;

  const windowFor = (ref: LimitSlotRef): LimitWindow | undefined => {
    const account = limitAccountOf(ref.accountId);
    const result = snapshot?.harnesses.find(
      (h) => h.harness === ref.harness && limitAccountOf(h.accountId) === account,
    );
    return result?.windows.find(
      (w) => w.windowId === ref.windowId && limitAccountOf(w.accountId) === account,
    );
  };

  const resultFor = (harness: string, accountId?: string): LimitsResult | undefined => {
    const account = limitAccountOf(accountId);
    return snapshot?.harnesses.find(
      (h) => h.harness === harness && limitAccountOf(h.accountId) === account,
    );
  };

  const refresh = async (): Promise<void> => {
    useLimitsStore.setState({ refreshing: true });
    try {
      const res = await api.refreshLimits();
      useLimitsStore.setState({
        snapshot: res.snapshot,
        refreshing: false,
        error: null,
        cooldownUntil: res.started
          ? null
          : res.retryAfterSecs != null
            ? Date.now() + res.retryAfterSecs * 1000
            : null,
      });
    } catch {
      useLimitsStore.setState({ refreshing: false, error: "Couldn't refresh limits" });
    }
  };

  const assignSlot = async (slotIndex: SlotIndex, picked: LimitSlotRef): Promise<void> => {
    const current = useLimitsStore.getState().snapshot?.slots ?? DEFAULT_SLOTS;
    const next = nextSlots(current, slotIndex, picked);
    const prev = useLimitsStore.getState().snapshot;
    useLimitsStore.setState({ snapshot: prev ? { ...prev, slots: next } : prev, error: null });
    try {
      const snapshot = await api.setLimitSlots(next);
      useLimitsStore.setState({ snapshot, error: null });
    } catch {
      useLimitsStore.setState({ snapshot: prev, error: "Couldn't update limit slot" });
    }
  };

  return { snapshot, loading, error, refreshing, cooldownUntil, slots, windowFor, resultFor, refresh, assignSlot };
}

/** Test-only: reset the module-level boot singleton + store for isolation. */
export function __resetLimitsBootForTests(): void {
  booted = false;
  bootOff?.();
  bootOff = null;
  useLimitsStore.setState({ snapshot: null, loading: false, error: null, refreshing: false, cooldownUntil: null });
}
