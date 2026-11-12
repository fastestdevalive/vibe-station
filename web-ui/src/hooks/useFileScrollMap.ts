import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api as defaultApi, type ApiInstance } from "@/api";
import type { FileScrollMap } from "@/api/types";

const DEFAULT_FILE_SCROLL_MAP: FileScrollMap = "minimap";
let currentFileScrollMap: FileScrollMap = DEFAULT_FILE_SCROLL_MAP;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): FileScrollMap {
  return currentFileScrollMap;
}

let bootedApi: ApiInstance | null = null;
let bootUnsub: (() => void) | null = null;

/** Test-only: reset module state for test isolation. */
export function __resetFileScrollMapForTests(): void {
  bootUnsub?.();
  bootUnsub = null;
  bootedApi = null;
  currentFileScrollMap = DEFAULT_FILE_SCROLL_MAP;
  listeners.clear();
}

/**
 * Server-synced file scroll map mode ("marks" | "minimap").
 * Boot once per api, sync via settings:updated, optimistic set + revert on rejection.
 */
export function useFileScrollMap(api: ApiInstance = defaultApi): [FileScrollMap, (next: FileScrollMap) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (bootedApi === api) return;
    bootUnsub?.();
    bootedApi = api;

    void (async () => {
      try {
        const settings = await api.getSettings();
        if (settings.fileScrollMap) {
          currentFileScrollMap = settings.fileScrollMap;
          emitChange();
        }
      } catch {
        // Server unreachable — keep fallback/optimistic value
      }
    })();

    bootUnsub = api.on("settings:updated", (ev) => {
      if (ev.type === "settings:updated" && ev.fileScrollMap) {
        currentFileScrollMap = ev.fileScrollMap;
        emitChange();
      }
    });
  }, [api]);

  const setFileScrollMap = useCallback(
    (next: FileScrollMap) => {
      const prev = currentFileScrollMap;
      currentFileScrollMap = next;
      emitChange();
      void api.updateSettings({ fileScrollMap: next }).catch(() => {
        currentFileScrollMap = prev;
        emitChange();
      });
    },
    [api],
  );

  return [value, setFileScrollMap];
}
