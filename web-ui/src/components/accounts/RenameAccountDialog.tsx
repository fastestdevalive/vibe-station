import { useEffect, useId, useState } from "react";
import type { ApiInstance } from "@/api";
import { isAccountError } from "@/api/errors";
import type { AccountSummary } from "@/api/types";
import { Dialog } from "@/components/dialogs/Dialog";
import { apiErrorText } from "@/lib/apiErrorText";
import "./accounts.css";

interface RenameAccountDialogProps {
  open: boolean;
  api: Pick<ApiInstance, "renameAccount">;
  cli: string;
  cliName: string;
  account: AccountSummary;
  onClose: () => void;
}

/**
 * "Rename account" dialog (plan B2.5): an optional label; an empty name clears
 * it (`label: null`), so the row falls back to the email/display name.
 */
export function RenameAccountDialog({
  open,
  api,
  cli,
  cliName,
  account,
  onClose,
}: RenameAccountDialogProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fieldId = useId();

  useEffect(() => {
    if (!open) return;
    setName(account.label ?? "");
    setError("");
    setBusy(false);
  }, [open, account]);

  async function save() {
    const label = name.trim();
    setError("");
    setBusy(true);
    try {
      await api.renameAccount(cli, account.id, label === "" ? null : label);
      onClose();
    } catch (e) {
      setError(
        isAccountError(e, "label_taken")
          ? `${label} is already a ${cliName} account name.`
          : apiErrorText(e, "Something went wrong."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={`Rename "${account.displayName}"`}
      onClose={onClose}
      cardClassName="accounts-dialog-card"
      overlayClassName="dialog-overlay--flush"
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <label className="accounts-dialog__label" htmlFor={fieldId}>
        Name (optional)
      </label>
      <input
        id={fieldId}
        className="accounts-dialog__input"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <p className="accounts-dialog__help">
        Prefilled names are optional. The email stays visible beside it.
      </p>
      {error ? (
        <div className="accounts-dialog__error" role="alert">
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}
