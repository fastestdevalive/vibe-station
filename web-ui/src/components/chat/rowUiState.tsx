import { createContext, useCallback, useContext, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/**
 * Per-`MessageList` row UI state (Decision 5). Virtualized rows unmount when
 * scrolled out of the viewport, which would destroy any local `useState` in a
 * row (a `ToolRunSummary`/`ThinkingBlock`'s open flag). This context holds a
 * `Map<string, boolean>` in a ref so that open/closed state survives a row
 * unmounting and remounting as it scrolls in and out.
 *
 * Keys are `run:<itemKey>`, `tool:<tool.id>` (children too), `think:<itemKey>`.
 *
 * When a `rowKey` is provided AND this provider is present, `useRowOpen` reads
 * and writes the map. Without either, it falls back to local component state —
 * so components remain testable and usable outside a `MessageList`.
 */

interface RowUiStore {
  /** Read the stored flag for `key`, or `undefined` if never set. */
  get: (key: string) => boolean | undefined;
  /** Write (or, when `v === dflt`, drop) the flag for `key`; notifies only that key's subscribers. */
  set: (key: string, v: boolean, dflt: boolean) => void;
  subscribe: (key: string, cb: () => void) => () => void;
}

const RowUiStateContext = createContext<RowUiStore | null>(null);

function createStore(): RowUiStore {
  const map = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (key) => map.get(key),
    set: (key, v, dflt) => {
      // A flag equal to its default carries no information — drop it so the
      // map doesn't grow with every row ever toggled.
      if (v === dflt) map.delete(key);
      else map.set(key, v);
      listeners.get(key)?.forEach((cb) => cb());
    },
    subscribe: (key, cb) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      return () => {
        set!.delete(cb);
        if (set!.size === 0) listeners.delete(key);
      };
    },
  };
}

export function RowUiStateProvider({ children }: { children: ReactNode }) {
  // Stable store identity: a toggle re-renders only the row that owns the key
  // (via useSyncExternalStore), not every consumer of the context.
  const storeRef = useRef<RowUiStore | null>(null);
  if (!storeRef.current) storeRef.current = createStore();
  return <RowUiStateContext.Provider value={storeRef.current}>{children}</RowUiStateContext.Provider>;
}

const NOOP_UNSUBSCRIBE = () => {};

/**
 * Read/write a boolean "open" flag keyed by `rowKey`, persisting it across
 * row unmount/remount via the `RowUiStateProvider`'s store. Falls back to local
 * `useState` when there is no provider or no `rowKey`.
 *
 * The setter mirrors `useState`'s: it accepts either a concrete boolean or an
 * updater `(prev) => next` (components toggle with `setOpen((v) => !v)`).
 */
export function useRowOpen(
  rowKey: string | undefined,
  dflt: boolean,
): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  const ctx = useContext(RowUiStateContext);
  const [local, setLocal] = useState(dflt);
  const subscribe = useCallback(
    (cb: () => void) => (ctx && rowKey != null ? ctx.subscribe(rowKey, cb) : NOOP_UNSUBSCRIBE),
    [ctx, rowKey],
  );
  const stored = useSyncExternalStore(
    subscribe,
    () => (ctx && rowKey != null ? ctx.get(rowKey) : undefined),
    () => undefined,
  );
  const setStored = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      if (!ctx || rowKey == null) return;
      const prev = ctx.get(rowKey) ?? dflt;
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      ctx.set(rowKey, next, dflt);
    },
    [ctx, rowKey, dflt],
  );

  if (rowKey != null && ctx) return [stored ?? dflt, setStored];
  return [local, setLocal];
}
