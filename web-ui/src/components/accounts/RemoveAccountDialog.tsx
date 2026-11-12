import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { AccountSummary, AccountUsage } from "@/api/types";
import { Dialog } from "@/components/dialogs/Dialog";
import { Button } from "@/components/ui/Button";
import { useServerStore } from "@/hooks/useServerStore";
import { apiErrorText } from "@/lib/apiErrorText";
import { accountName, removeVerb } from "@/lib/accounts";
import { AccountChip } from "./AccountChip";
import "./accounts.css";

interface RemoveAccountDialogProps {
  open: boolean;
  api: Pick<ApiInstance, "getAccountUsage" | "removeAccount">;
  cli: string;
  account: AccountSummary;
  onClose: () => void;
}

function sessionsWord(n: number): string {
  return n === 1 ? "session" : "sessions";
}

/** The session sentence from its non-zero parts only. */
export function usageSentence(running: number, past: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running ${sessionsWord(running)} will stop.`);
  if (past > 0) {
    parts.push(
      `${past} past ${sessionsWord(past)} keep their history and will ask for an account when resumed.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : "No sessions use this account.";
}

/**
 * "Remove" / "Unlink" dialog (plan B2.4, B2a.3): how many running/past
 * sessions the account has and what the action does to its folder. A folder
 * vibe-station created is deleted; a chosen folder is only forgotten.
 */
export function RemoveAccountDialog({ open, api, cli, account, onClose }: RemoveAccountDialogProps) {
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setUsage(null);
    setError("");
    void api
      .getAccountUsage(cli, account.id)
      .then((next) => {
        if (!cancelled) setUsage(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(apiErrorText(e, "Something went wrong."));
      });
    return () => {
      cancelled = true;
    };
  }, [open, api, cli, account.id]);

  async function remove() {
    setError("");
    setBusy(true);
    try {
      await api.removeAccount(cli, account.id);
      // The requester applies its own response; the broadcast is for others.
      useServerStore.getState().applyAccountRemoved(cli, account.id);
      onClose();
    } catch (e) {
      setError(apiErrorText(e, "Something went wrong."));
    } finally {
      setBusy(false);
    }
  }

  const created = account.createdByUs === true;
  const verb = removeVerb(account);
  const dir = account.dir ?? "";

  return (
    <Dialog
      open={open}
      title={`${verb} "${accountName(account)}"?`}
      onClose={onClose}
      cardClassName="accounts-dialog-card"
      overlayClassName="dialog-overlay--flush"
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          {created ? (
            <Button
              disabled={busy || usage === null}
              style={{ borderColor: "var(--destructive)", color: "var(--destructive)" }}
              onClick={() => void remove()}
            >
              {busy ? "Removing…" : "Remove and delete folder"}
            </Button>
          ) : (
            <Button disabled={busy || usage === null} onClick={() => void remove()}>
              {busy ? "Unlinking…" : "Unlink"}
            </Button>
          )}
        </>
      }
    >
      <AccountChip account={account} variant="row" showPlan />
      {usage ? (
        <p className="accounts-dialog__text">{usageSentence(usage.running.length, usage.pastCount)}</p>
      ) : (
        <p className="accounts-dialog__text">Checking sessions…</p>
      )}
      {created ? (
        <>
          <p className="accounts-dialog__text">This folder and its sign-in are deleted:</p>
          <p className="accounts-dialog__text">
            <code>{dir}</code>
          </p>
          <p className="accounts-dialog__text">Your System login is not touched.</p>
        </>
      ) : (
        <>
          <p className="accounts-dialog__text">
            vibe-station forgets this account. Your folder is not touched and stays signed in:
          </p>
          <p className="accounts-dialog__text">
            <code>{dir}</code>
          </p>
          <p className="accounts-dialog__text">You can add it again later.</p>
        </>
      )}
      {error ? (
        <div className="accounts-dialog__error" role="alert">
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}
