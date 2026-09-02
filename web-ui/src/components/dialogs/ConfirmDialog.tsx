import { Dialog } from "./Dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * When true, disables the confirm button and blocks `onConfirm` from firing
   * (json-mode-followups item 2, Decision 4). Re-evaluated on every render so
   * a value derived from LIVE state (e.g. session busy-ness) can flip while
   * the dialog sits open, instead of going stale at the moment it was opened.
   * Defaults `false` — fully backward-compatible with existing callers.
   */
  confirmDisabled?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
  confirmDisabled = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            style={{ borderColor: "var(--destructive)", color: "var(--destructive)" }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--fg-secondary)", whiteSpace: "pre-wrap" }}>
        {message}
      </p>
    </Dialog>
  );
}
