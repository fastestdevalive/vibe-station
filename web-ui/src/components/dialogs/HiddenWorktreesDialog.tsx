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

/** Per-project list of hidden worktrees (see `wtMenu`'s "Hide" item in
 *  LeftSidebar), with an "Unhide" action per row. Opened from the project's
 *  overflow menu — a hidden worktree has no other UI surface once hidden. */
export function HiddenWorktreesDialog({ open, worktrees, api, onClose }: HiddenWorktreesDialogProps) {
  return (
    <Dialog open={open} title="Hidden worktrees" onClose={onClose}>
      {worktrees.length === 0 ? (
        <p style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--fg-secondary)" }}>
          No hidden worktrees.
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
                    aria-label={`Unhide ${label}`}
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
                    Unhide
                  </button>
                </li>
              );
            })}
        </ul>
      )}
    </Dialog>
  );
}
