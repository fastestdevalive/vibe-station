import { create } from "zustand";
import { useEffect } from "react";
import type { ApiInstance } from "@/api";
import type { Mode } from "@/api/types";

/** The slice of the api the modes cache needs: one fetch plus the `mode:*` / `ws:open` events. */
export type ModesApi = Pick<ApiInstance, "listModes" | "on">;

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
export async function reloadModes(api: ModesApi): Promise<void> {
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
export function ensureLoaded(api: ModesApi): Promise<void> {
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
export function subscribeModes(api: ModesApi): () => void {
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
let sharedApi: ModesApi | null = null;
let sharedRefs = 0;
let sharedOff: (() => void) | null = null;

/** Demo hard-reset: drop the shared load + subscription singletons. */
export function __resetForDemo(): void {
  pendingLoad = null;
  sharedOff?.();
  sharedApi = null;
  sharedRefs = 0;
  sharedOff = null;
}

export function retainSubscription(api: ModesApi): () => void {
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
 * ensures the store is loaded and shares a single live subscription.
 *
 * `snapshot` is the session's own `modeIcon` (stamped by the daemon at creation).
 * It wins over the live mode lookup, so a session keeps the icon it started
 * with after its mode is edited or deleted; the live lookup only covers records
 * without a snapshot (drafts, legacy rows). Returns `null` (fallback) when
 * neither resolves.
 */
export function useModeIcon(
  modeId: string | null | undefined,
  api?: ModesApi,
  snapshot?: string | null,
): string | null {
  const live = useModesStore((s) => resolveIcon(s.modes, modeId));
  useModesSync(api);
  return snapshot ?? live;
}

/**
 * Load the modes once and hold the shared live subscription while mounted. A surface that renders many icons
 * (a list) calls this once and renders its icons without an `api`.
 */
export function useModesSync(api?: ModesApi): void {
  useEffect(() => {
    if (!api) return;
    void ensureLoaded(api);
    return retainSubscription(api);
  }, [api]);
}

