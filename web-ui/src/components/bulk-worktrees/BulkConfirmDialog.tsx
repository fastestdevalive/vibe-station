import { Dialog } from "@/components/dialogs/Dialog";

export interface BulkConfirmItem {
  id: string;
  label: string;
  /** A `working` agent lives in this worktree (Decision 7). */
  running: boolean;
}

export interface BulkConfirmDialogProps {
  open: boolean;
  items: readonly BulkConfirmItem[];
  /** The worktree currently open in the workspace, when it is in `items` (Decision 8). */
  openItem?: BulkConfirmItem | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Delete confirmation (design `Confirm.dc.html` / `DeleteDialog.dc.html`) —
 * built on `Dialog` rather than `ConfirmDialog` because the body lists the
 * worktrees and carries conditional warnings. Archive skips confirmation
 * entirely, so this is delete-only.
 */
export function BulkConfirmDialog({
  open,
  items,
  openItem,
  onCancel,
  onConfirm,
}: BulkConfirmDialogProps) {
  const count = items.length;
  const noun = count === 1 ? "worktree" : "worktrees";
  const runningCount = items.filter((item) => item.running).length;

  return (
    <Dialog
      open={open}
      title={`Delete ${count} ${noun}?`}
      onClose={onCancel}
      cardClassName="bulk-confirm-dialog"
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn bulk-btn--destructive" onClick={onConfirm}>
            Delete {count}
          </button>
        </>
      }
    >
      <p className="bulk-confirm__intro">
        Sessions attached to these worktrees will be removed from the UI.
      </p>
      <div className="bulk-confirm__list">
        {items.map((item) => (
          <div key={item.id} className="bulk-confirm__item">
            <span className="bulk-confirm__label">{item.label}</span>
          </div>
        ))}
      </div>
      {runningCount > 0 ? (
        <p className="bulk-confirm__warning">
          {runningCount === 1
            ? "1 of these worktrees has an agent running; it will be stopped."
            : `${runningCount} of these worktrees have agents running; they will be stopped.`}
        </p>
      ) : null}
      {openItem ? (
        <p className="bulk-confirm__warning">
          You are viewing “{openItem.label}”; you'll be taken to the dashboard.
        </p>
      ) : null}
    </Dialog>
  );
}
