import { useSyncExternalStore } from "react";

export interface FindPaneRegistration {
  /** Stable per-pane key: two panes may show the same session. */
  paneId: string;
  sessionId: string;
  open: (seed?: string) => void;
  lastFocusedAt: number;
}

const registry = new Map<string, FindPaneRegistration>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function registerFindPane(reg: FindPaneRegistration): () => void {
  registry.set(reg.paneId, reg);
  notify();
  return () => {
    if (registry.get(reg.paneId) === reg) registry.delete(reg.paneId);
    notify();
  };
}

/** Marks the pane registered under `paneId` as the most recently focused one. */
export function updateFindPaneFocus(paneId: string): void {
  const reg = registry.get(paneId);
  if (!reg) return;
  reg.lastFocusedAt = Date.now();
  notify();
}

function getActiveFindPane(): FindPaneRegistration | null {
  if (registry.size === 0) return null;
  let best: FindPaneRegistration | null = null;
  for (const reg of registry.values()) {
    if (!best || reg.lastFocusedAt > best.lastFocusedAt) {
      best = reg;
    }
  }
  return best;
}

export function useActiveFindPane(): FindPaneRegistration | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getActiveFindPane,
    () => null,
  );
}
