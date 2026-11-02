import { useEffect, useRef } from "react";
import { api as defaultApi, type ApiInstance } from "@/api";
import { useWorkspaceStore } from "./useStore";

/**
 * Fires `POST /worktrees/:id/focus` once each time a worktree becomes the
 * opened one, so the daemon-side PR and diffstat pollers can
 * refresh that worktree sooner instead of waiting for their next tick.
 *
 * Mount-only hook — the shell calls `useWorktreeFocusHint()` and nothing else.
 * Fire-and-forget: the hint is a latency optimisation, so a failure is
 * swallowed rather than surfaced.
 */
export function useWorktreeFocusHint(apiInstance: ApiInstance = defaultApi): void {
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const lastHinted = useRef<string | null>(null);

  useEffect(() => {
    if (!activeWorktreeId) {
      lastHinted.current = null;
      return;
    }
    if (lastHinted.current === activeWorktreeId) return;
    lastHinted.current = activeWorktreeId;
    void apiInstance.focusWorktree(activeWorktreeId).catch(() => {});
  }, [activeWorktreeId, apiInstance]);
}
