import { Dialog } from "./Dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
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
            style={{ borderColor: "var(--destructive)", color: "var(--destructive)" }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--fg-secondary)" }}>
        {message}
      </p>
    </Dialog>
  );
}
