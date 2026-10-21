import type { ApiInstance } from "@/api";
import type { Worktree } from "@/api/types";
import { Dialog } from "./Dialog";

interface HiddenWorktreesDialogProps {
  open: boolean;
  /** Hidden worktrees for the project this dialog was opened from. */
  worktrees: Worktree[];
  api: ApiInstance;
  onClose: () => void;
}

/** Per-project list of archived worktrees (see `wtMenu`'s "Archive" item in
 *  LeftSidebar), with an "Unarchive" action per row. Opened from the project's
 *  overflow menu — an archived worktree has no other UI surface. */
export function HiddenWorktreesDialog({ open, worktrees, api, onClose }: HiddenWorktreesDialogProps) {
  return (
    <Dialog open={open} title="Archived worktrees" onClose={onClose}>
      {worktrees.length === 0 ? (
        <p style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--fg-secondary)" }}>
          No archived worktrees.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {worktrees
            .slice()
            .sort((a, b) => (b.hiddenAt ?? "").localeCompare(a.hiddenAt ?? ""))
            .map((w) => {
              const label = w.name ?? w.branch;
              return (
                <li
                  key={w.id}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)" }}
                >
                  <span style={{ fontSize: "var(--font-size-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {label}
                  </span>
                  <button
                    type="button"
                    aria-label={`Unarchive ${label}`}
                    onClick={() => {
                      void (async () => {
                        try {
                          await api.unhideWorktree(w.id);
                          // Store stays current via the `worktree:updated` WS event.
                        } catch {
                          /* surface errors later */
                        }
                      })();
                    }}
                  >
                    Unarchive
                  </button>
                </li>
              );
            })}
        </ul>
      )}
    </Dialog>
  );
}
