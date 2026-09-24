import { useState } from "react";
import { ApiError } from "@/api/errors";
import { Dialog } from "./Dialog";

interface NonGitWorktreeDialogProps {
  open: boolean;
  /**
   * Runs "git init and continue" for the offending project: the caller does
   * the `POST /projects/:id/git-init` + original `createWorktree` retry (CUJ
   * 3). Must resolve once the worktree was successfully created (the dialog
   * closes), and reject if `git init` failed so this dialog can show an
   * inline error and re-enable its primary button (CUJ 3 error path).
   */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Recovery dialog shown when worktree creation fails because the project isn't
 * git-initialized (`POST /worktrees` returned 422 `NOT_GIT`). Per the PRD
 * screen layout it offers a "Run git init and continue" primary action (which
 * git-inits the project then proceeds with the original worktree request, no
 * flow restart — R10) and a "Cancel" secondary action.
 */
export function NonGitWorktreeDialog({ open, onConfirm, onCancel }: NonGitWorktreeDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      // Success — the caller closes the dialog (sets `open` false) itself.
    } catch (err) {
      setError(errorMessage(err, "git init failed."));
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Can't create worktree"
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleConfirm()} disabled={submitting}>
            {submitting ? "Running git init…" : "Run git init and continue"}
          </button>
        </>
      }
    >
      <p
        style={{
          margin: 0,
          fontSize: "var(--font-size-sm)",
          color: "var(--fg-secondary)",
          whiteSpace: "pre-wrap",
        }}
      >
        This project isn't a git repository, so a worktree (an isolated branch checkout) can't be
        created here.
      </p>
      {error ? (
        <p style={{ marginTop: 12, marginBottom: 0, fontSize: "var(--font-size-sm)", color: "var(--destructive)" }}>
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
