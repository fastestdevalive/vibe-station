import { useEffect, useRef } from "react";
import type { ApiInstance } from "@/api";
import type { WSEvent } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * Two-path file-open consumer (D5):
 *
 * 1. WS live path: subscribe to `file:open` events for the active worktree;
 *    open the file immediately when the event arrives.
 * 2. Late-join HTTP path: on mount (or when worktreeId changes), fetch the
 *    pending queue from the daemon and open each queued file, then ack with
 *    DELETE to prevent double-opens on reconnect.
 */
export function usePendingFileOpens(api: ApiInstance, worktreeId: string | null): void {
  const openFileTabNew = useWorkspaceStore((s) => s.openFileTabNew);
  const setToolPanelTab = useWorkspaceStore((s) => s.setToolPanelTab);

  // WS live path — handle file:open events for this panel's worktree.
  useEffect(() => {
    if (!worktreeId) return;
    const unsub = api.on("file:open", (ev: WSEvent) => {
      if (ev.type !== "file:open") return;
      if (ev.worktreeId !== worktreeId) return;
      openFileTabNew(ev.worktreeId, ev.path);
      setToolPanelTab("files");
      // Ack the pending queue so the HTTP late-join path doesn't re-open
      // the same file the next time FilesPanel mounts.
      void api.clearPendingFileOpens(ev.worktreeId).catch(() => undefined);
    });
    return unsub;
  }, [api, worktreeId, openFileTabNew, setToolPanelTab]);

  // HTTP late-join path — fetch queued paths on mount and ack.
  const fetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!worktreeId) return;
    if (fetchedRef.current === worktreeId) return;
    fetchedRef.current = worktreeId;

    void (async () => {
      try {
        const { paths } = await api.getPendingFileOpens(worktreeId);
        if (paths.length === 0) return;
        for (const path of paths) {
          openFileTabNew(worktreeId, path);
        }
        setToolPanelTab("files");
        await api.clearPendingFileOpens(worktreeId);
      } catch {
        // Best-effort — a missing worktree or network error should not crash the panel.
      }
    })();
  }, [api, worktreeId, openFileTabNew, setToolPanelTab]);
}
