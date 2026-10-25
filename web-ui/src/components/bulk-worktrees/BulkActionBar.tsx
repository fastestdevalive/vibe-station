import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { useEventTargets } from "@/context/DemoEnv";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { worktreeLabel } from "@/lib/sessionLabel";
import { worktreeRolledUpStatus } from "@/lib/worktreeStatus";
import { BulkConfirmDialog, type BulkConfirmItem } from "./BulkConfirmDialog";
import { useBulkWorktreeActions } from "./useBulkWorktreeActions";
import { useBulkWorktrees } from "./useBulkWorktrees";

export interface BulkActionBarProps {
  api: ApiInstance;
  /** Collapsing the rail exits select mode (Decision 9). */
  collapsed: boolean;
}

/**
 * Bottom-pinned select-mode bar (design `Select.dc.html`): "N selected",
 * Cancel, and the primary action. Delete opens the confirm dialog; archive
 * starts straight away (no confirmation, matching the single-row archive).
 *
 * A plain flex child of `.left-sidebar` (Decision 2) so it survives route
 * changes and never overlaps the scroll area.
 */
export function BulkActionBar({ api, collapsed }: BulkActionBarProps) {
  const { doc } = useEventTargets();
  const location = useLocation();
  const mode = useBulkWorktrees((s) => s.mode);
  const selected = useBulkWorktrees((s) => s.selected);
  const exit = useBulkWorktrees((s) => s.exit);
  const worktrees = useServerStore((s) => s.worktrees);
  const sessions = useServerStore((s) => s.sessions);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const { start } = useBulkWorktreeActions(api);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Truthful count: ids the server no longer knows are dropped (Decision 3 —
  // the store prunes too, this is the belt-and-braces read).
  const items = useMemo<BulkConfirmItem[]>(() => {
    if (!mode) return [];
    const worktreeById = new Map(worktrees.map((w) => [w.id, w]));
    const sessionsByWorktree: Record<string, Session[]> = {};
    for (const s of sessions) {
      if (s.worktreeId != null) (sessionsByWorktree[s.worktreeId] ??= []).push(s);
    }
    return [...selected].flatMap((id) => {
      const w = worktreeById.get(id);
      if (!w) return [];
      return [
        {
          id,
          label: worktreeLabel(w),
          running: worktreeRolledUpStatus(sessionsByWorktree[id] ?? [], sessionStates) === "working",
        },
      ];
    });
  }, [mode, selected, worktrees, sessions, sessionStates]);

  const openItem = useMemo(() => {
    if (!location.pathname.startsWith("/worktree/") || activeWorktreeId == null) return null;
    return items.find((item) => item.id === activeWorktreeId) ?? null;
  }, [location.pathname, activeWorktreeId, items]);

  // Esc leaves select mode. Not while the confirm dialog is open — the
  // Dialog's own Esc handler only stops the *React* event; other document
  // listeners still fire (see plan Research), so gate it here instead.
  useEffect(() => {
    if (!mode || confirmOpen) return undefined;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") exit();
    }
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [mode, confirmOpen, exit, doc]);

  useEffect(() => {
    if (collapsed && mode) exit();
  }, [collapsed, mode, exit]);

  if (!mode) return null;

  const count = items.length;
  const disabled = count === 0;
  const ids = items.map((item) => item.id);

  return (
    <>
      <div className="bulk-action-bar">
        <span className="bulk-action-bar__count">{count} selected</span>
        <button type="button" className="btn btn--secondary" onClick={() => exit()}>
          Cancel
        </button>
        <button
          type="button"
          className={mode === "delete" ? "btn bulk-action-bar__delete" : "btn btn--primary"}
          disabled={disabled}
          aria-disabled={disabled}
          onClick={() => {
            if (disabled) return;
            if (mode === "delete") setConfirmOpen(true);
            else start("archive", ids);
          }}
        >
          {mode === "archive" ? "Archive" : "Delete"} {count}
        </button>
      </div>
      {mode === "delete" ? (
        <BulkConfirmDialog
          open={confirmOpen}
          items={items}
          openItem={openItem}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            start("delete", ids);
          }}
        />
      ) : null}
    </>
  );
}
