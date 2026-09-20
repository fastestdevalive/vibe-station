import { create } from "zustand";
import { useEffect } from "react";
import type { ApiInstance } from "@/api";
import type { Mode } from "@/api/types";

/**
 * Client-side cache mapping `modeId` → `Mode`, so surfaces (tabs, chips,
 * dashboard cards) can resolve a session's `modeId` to its icon without a
 * per-surface fetch. Populated once via `ensureLoaded(api)` and kept in sync
 * with the daemon's `mode:created/updated/deleted` WS events via `subscribe`.
 *
 * Deliberately a module-level singleton (matching the project's zustand v5
 * convention in `globalDraftStore.ts`) — every surface resolves the same live
 * modes so an icon is never stale in one place and fresh in another.
 */
interface ModesState {
  modes: Map<string, Mode>;
  loaded: boolean;
  setModes: (modes: Mode[]) => void;
  applyCreated: (mode: Mode) => void;
  applyUpdated: (mode: Mode) => void;
  applyDeleted: (modeId: string) => void;
  /** Reset to the pristine empty state (tests only). */
  _reset: () => void;
}

export const useModesStore = create<ModesState>()((set) => ({
  modes: new Map(),
  loaded: false,
  setModes: (modes) => set({ modes: new Map(modes.map((m) => [m.id, { ...m }])), loaded: true }),
  applyCreated: (mode) =>
    set((s) => {
      const next = new Map(s.modes);
      next.set(mode.id, { ...mode });
      return { modes: next };
    }),
  applyUpdated: (mode) =>
    set((s) => {
      const next = new Map(s.modes);
      next.set(mode.id, { ...mode });
      return { modes: next };
    }),
  applyDeleted: (modeId) =>
    set((s) => {
      const next = new Map(s.modes);
      next.delete(modeId);
      return { modes: next };
    }),
  _reset: () => set({ modes: new Map(), loaded: false }),
}));

/**
 * Populate the store's modes map once from the API. Safe to call from multiple
 * surfaces; a second call is a no-op once `loaded`.
 */
let pendingLoad: Promise<void> | null = null;

/** Fetch the modes and replace the cache. Failures keep the previous cache so
 *  callers keep rendering the last-known icons (or the fallback glyph). */
export async function reloadModes(api: ApiInstance): Promise<void> {
  try {
    useModesStore.getState().setModes(await api.listModes());
  } catch {
    // Leave the cache as-is; a later reload (next ws:open) can succeed.
  }
}

/**
 * Populate the store's modes map once from the API. Safe to call from every
 * rendered icon: a second call is a no-op once `loaded`, and concurrent calls
 * share one in-flight request.
 */
export function ensureLoaded(api: ApiInstance): Promise<void> {
  if (useModesStore.getState().loaded) return Promise.resolve();
  pendingLoad ??= reloadModes(api).finally(() => {
    pendingLoad = null;
  });
  return pendingLoad;
}

/**
 * Subscribe to the daemon's `mode:*` WS events and apply them to the store;
 * also re-seeds the whole map on every `ws:open` so events missed while
 * disconnected can't leave icons stale. Returns an unsubscribe function.
 */
export function subscribeModes(api: ApiInstance): () => void {
  const offCreated = api.on("mode:created", (ev) => {
    if (ev.type === "mode:created") useModesStore.getState().applyCreated(ev.mode);
  });
  const offUpdated = api.on("mode:updated", (ev) => {
    if (ev.type === "mode:updated") useModesStore.getState().applyUpdated(ev.mode);
  });
  const offDeleted = api.on("mode:deleted", (ev) => {
    if (ev.type === "mode:deleted") useModesStore.getState().applyDeleted(ev.modeId);
  });
  const offOpen = api.on("ws:open", () => {
    if (useModesStore.getState().loaded) void reloadModes(api);
  });
  return () => {
    offCreated();
    offUpdated();
    offDeleted();
    offOpen();
  };
}

// Every rendered icon calls `useModeIcon`; they share ONE subscription per api,
// held while at least one icon is mounted.
let sharedApi: ApiInstance | null = null;
let sharedRefs = 0;
let sharedOff: (() => void) | null = null;

function retainSubscription(api: ApiInstance): () => void {
  if (sharedApi !== api) {
    sharedOff?.();
    sharedApi = api;
    sharedRefs = 0;
    sharedOff = subscribeModes(api);
  }
  sharedRefs += 1;
  return () => {
    sharedRefs -= 1;
    if (sharedRefs === 0) {
      sharedOff?.();
      sharedOff = null;
      sharedApi = null;
    }
  };
}

/**
 * Pure selector: resolve a `modeId` to its icon key, or `null` when the mode
 * is unknown (not yet loaded / deleted / never existed). Surfaces render the
 * generic fallback glyph for `null`.
 */
export function iconForMode(modeId: string | null | undefined): string | null {
  return resolveIcon(useModesStore.getState().modes, modeId);
}

function resolveIcon(modes: Map<string, Mode>, modeId: string | null | undefined): string | null {
  return modeId ? (modes.get(modeId)?.icon ?? null) : null;
}

/**
 * Reactive hook: resolve `modeId` → icon key, re-rendering the caller when the
 * mode arrives/updates/deletes in the store. When `api` is provided it lazily
 * ensures the store is loaded and shares a single live subscription. Returns `null`
 * (fallback) when the mode is unknown.
 */
export function useModeIcon(
  modeId: string | null | undefined,
  api?: ApiInstance,
): string | null {
  const icon = useModesStore((s) => resolveIcon(s.modes, modeId));
  useEffect(() => {
    if (!api) return;
    void ensureLoaded(api);
    return retainSubscription(api);
  }, [api]);
  return icon;
}

