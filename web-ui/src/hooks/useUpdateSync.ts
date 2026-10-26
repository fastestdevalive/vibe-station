import { useEffect } from "react";
import type { ApiInstance } from "@/api";
import { fetchUpdateStatus } from "@/api/update";
import { markRestartReload } from "@/lib/restartMarker";
import { useUpdateStore } from "./useUpdateStore";

const UPDATE_EVENTS = [
  "update:available",
  "update:progress",
  "update:installed",
  "update:changed",
] as const;

/**
 * Keeps `useUpdateStore` in step with the daemon: a (non-forced) fetch on
 * mount and on every WS (re)connect (each also refreshing the reload
 * baselines from `/health`), plus every `update:*` event replacing
 * the snapshot. Fetch errors leave the store untouched.
 */
export function useUpdateSync(api: ApiInstance): void {
  useEffect(() => {
    let cancelled = false;
    let initialVersion: string | null = null;

    const refresh = () => {
      fetchUpdateStatus(false)
        .then((resp) => {
          if (!cancelled) useUpdateStore.getState().setFromCheck(resp);
        })
        .catch(() => {
          /* keep the last known snapshot */
        });

      api.health()
        .then((h) => {
          if (cancelled) return;
          if (initialVersion && h.version && h.version !== initialVersion) {
            markRestartReload();
            return;
          }
          // Baselines refresh on every successful health, so a failed first
          // call (or a restart this tab slept through) cannot leave them
          // stale. Not while restarting: the overlay needs the pre-restart id.
          if (initialVersion === null && h.version) initialVersion = h.version;
          if (h.bootId && !useUpdateStore.getState().restarting) {
            useUpdateStore.getState().setLoadBootId(h.bootId);
          }
        })
        .catch(() => {});
    };
    refresh();
    const offs = [
      api.on("ws:open", refresh),
      api.on("daemon:restarting", () => {
        useUpdateStore.getState().setRestarting(true);
      }),
      ...UPDATE_EVENTS.map((type) =>
        api.on(type, (ev) => {
          if (ev.type === type && "status" in ev) useUpdateStore.getState().setStatus(ev.status);
        }),
      ),
    ];
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
    };
  }, [api]);
}
