import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";

/**
 * Registry of "actions hosts": slots in a pane's top row. Pane controls portal into a host's pane span by scope.
 * The global Search / "…" / toggle chip is rendered once by `TopActionsOwner` at the top-right of `#workspace-layout`
 * and never moves; the registry only picks which host row reserves the chip's width (its reserve span).
 */
/** Zones that can reserve the chip's width (`TopActionsOwner`'s `zones`, Layout's routing). */
export type GroupZone = "tools" | "agent" | "canvas";

/**
 * Host priorities (higher wins inside a zone; ties go to the earliest registration, so a host that re-registers
 * on a prop change can lose a tie it used to win: give competing hosts DIFFERENT priorities).
 * canvasToolbar 2 > canvasTile 1 > default 0 > filesBarFallback -1 (the Files bar while a list header reserves the chip).
 */
export const HOST_PRIORITY = { canvasToolbar: 2, canvasTile: 1, default: 0, filesBarFallback: -1 } as const;

export interface HostEntry {
  /** Debug/test key only: the store never reads it. */
  id: string;
  /** Zone whose row may reserve the chip's width; `null` = never reserves. */
  zone: GroupZone | null;
  /** Per-panel scope for pane-level controls (a `ToolPanel`'s `hostScope`). */
  scope: string | null;
  priority: number;
  /** Registration order; ties on `priority` go to the lowest `seq`. */
  seq: number;
  paneEl: HTMLElement;
  /** Empty spacer span, token-sized in CSS when this host is the one under the chip. */
  reserveEl: HTMLElement;
}

export type HostQuery = { zones: GroupZone[] } | { scope: string };

export interface TopActionsStore {
  register(entry: Omit<HostEntry, "seq">): () => void;
  /** Returns the SAME object while the picked entry is unchanged. */
  pick(query: HostQuery): HostEntry | null;
  subscribe(cb: () => void): () => void;
  /** Zones the chip may sit over (set by `TopActionsOwner`); `[]` = no chip, no reserve. */
  setReserveZones(zones: GroupZone[]): void;
  /** The host whose row reserves the chip's width (best host of the first zone that has one), or null. */
  reserveHost(): HostEntry | null;
}

function better(a: HostEntry, b: HostEntry): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.seq < b.seq;
}

function best(entries: HostEntry[]): HostEntry | null {
  let winner: HostEntry | null = null;
  for (const e of entries) {
    if (winner == null || better(e, winner)) winner = e;
  }
  return winner;
}

export function createTopActionsStore(): TopActionsStore {
  let entries: HostEntry[] = [];
  let seq = 0;
  let reserveZones: GroupZone[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const cb of Array.from(listeners)) cb();
  };

  function pick(query: HostQuery): HostEntry | null {
    if ("scope" in query) {
      return best(entries.filter((e) => e.scope === query.scope));
    }
    for (const zone of query.zones) {
      const winner = best(entries.filter((e) => e.zone === zone));
      if (winner) return winner;
    }
    return null;
  }

  return {
    register(entry) {
      const stored: HostEntry = { ...entry, seq: seq++ };
      entries = [...entries, stored];
      emit();
      return () => {
        if (!entries.includes(stored)) return;
        entries = entries.filter((e) => e !== stored);
        emit();
      };
    },
    pick,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setReserveZones(zones) {
      if (zones.length === reserveZones.length && zones.every((z, k) => z === reserveZones[k])) return;
      reserveZones = zones;
      emit();
    },
    reserveHost() {
      return pick({ zones: reserveZones });
    },
  };
}

const TopActionsContext = createContext<TopActionsStore | null>(null);

/** The store is created once by the caller (stable); the context value never changes. */
export function TopActionsProvider({
  store,
  children,
}: {
  store?: TopActionsStore;
  children: ReactNode;
}) {
  const fallback = useRef<TopActionsStore | null>(null);
  if (store == null && fallback.current == null) fallback.current = createTopActionsStore();
  return (
    <TopActionsContext.Provider value={store ?? (fallback.current as TopActionsStore)}>
      {children}
    </TopActionsContext.Provider>
  );
}

/** `null` outside a provider (gallery, bare tests). */
export function useTopActionsStore(): TopActionsStore | null {
  return useContext(TopActionsContext);
}

const NOOP_SUBSCRIBE = () => () => {};
const NULL_SNAPSHOT = () => null;

export function useActionsHost(query: HostQuery | null): HostEntry | null {
  const store = useTopActionsStore();
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store && query ? () => store.pick(query) : NULL_SNAPSHOT,
  );
}

/** True for exactly the host whose reserve span is `el` (the one row under the chip). */
export function useIsReserveHost(el: HTMLElement | null): boolean {
  const store = useTopActionsStore();
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? () => el != null && store.reserveHost()?.reserveEl === el : () => false,
  );
}
