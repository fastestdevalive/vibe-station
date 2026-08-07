import { useEffect, useState } from "react";
import { Dialog } from "./Dialog";

interface RenameDialogProps {
  open: boolean;
  title: string;
  /** Current display name to prefill. */
  currentName: string;
  onCancel: () => void;
  /** Called with the trimmed, non-empty new name. */
  onSubmit: (name: string) => void;
}

const MAX_LEN = 60;

/**
 * Generic rename modal — prototype-only, local/optimistic (see
 * .feature-plans/sqlite_agent_naming_plan.md F1-F3: no daemon rename endpoint
 * exists yet, so callers just update client-side name-override state).
 * Shared by worktree rename, direct-session rename, and (indirectly) the
 * tab-strip's inline rename affordance uses its own lighter-weight input
 * instead of this dialog — see TabsStrip.tsx for that judgment call.
 */
export function RenameDialog({ open, title, currentName, onCancel, onSubmit }: RenameDialogProps) {
  const [value, setValue] = useState(currentName);

  useEffect(() => {
    if (open) setValue(currentName);
  }, [open, currentName]);

  const trimmed = value.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_LEN;

  function submit() {
    if (!valid) return;
    onSubmit(trimmed);
  }

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
          <button type="button" onClick={submit} disabled={!valid}>
            Rename
          </button>
        </>
      }
    >
      <input
        type="text"
        value={value}
        maxLength={MAX_LEN}
        data-autofocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "var(--space-2)",
          fontSize: "var(--font-size-sm)",
        }}
        aria-label="New name"
      />
    </Dialog>
  );
}
