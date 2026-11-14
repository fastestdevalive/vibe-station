import { useEffect } from "react";
import type { ApiInstance } from "@/api";
import { useVcsCacheStore } from "./vcsCacheStore";

/**
 * The single VCS-cache subscription, mounted once from Workspace beside `useCommentsSync(api)`.
 * Events only invalidate: `worktree:head` marks that worktree's entries stale; `ws:open` / `ws:resync` mark all stale.
 * The mounted list (`useVcsCommits`) does the refetch.
 */
export function useVcsSync(api: ApiInstance): void {
  useEffect(() => {
    const offHead = api.on("worktree:head", (ev) => {
      if (ev.type === "worktree:head") {
        useVcsCacheStore.getState().applyHead(ev.worktreeId, ev.headSha, ev.baseSha, ev.rev);
      }
    });
    const offOpen = api.on("ws:open", () => useVcsCacheStore.getState().markAllStale());
    const offResync = api.on("ws:resync", () => useVcsCacheStore.getState().markAllStale());
    return () => {
      offHead();
      offOpen();
      offResync();
    };
  }, [api]);
}
