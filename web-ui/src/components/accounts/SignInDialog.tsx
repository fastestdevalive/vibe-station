import { useState } from "react";
import type { ApiInstance } from "@/api";
import { isAccountError } from "@/api/errors";
import type { AccountSummary } from "@/api/types";
import { Dialog } from "@/components/dialogs/Dialog";
import { useServerStore } from "@/hooks/useServerStore";
import { apiErrorText } from "@/lib/apiErrorText";
import { accountName } from "@/lib/accounts";
import { AccountChip } from "./AccountChip";
import { SignInSteps } from "./SignInSteps";
import { openSignInTerminal, useCanOpenSignInTerminal } from "./signInTerminal";
import "./accounts.css";

interface SignInDialogProps {
  open: boolean;
  api: Pick<ApiInstance, "refreshAccount" | "restartAccountSignIn">;
  cli: string;
  account: AccountSummary;
  verifiesIdentity: boolean;
  /** The CLI's `accountLink.firstRunNote` (server text), shown under the steps. */
  firstRunNote?: string | null;
  /** The daemon deleted a pending row on the check (duplicate identity / not found); shows why. */
  onGone?: (message: string) => void;
  onClose: () => void;
}

/**
 * The one sign-in dialog (banner, Settings row, anywhere an account is
 * "Signed out" or "Waiting for sign-in"): the account, then the numbered,
 * copyable steps with Check again. A Terminal opens only when the user asks
 * for it, and the button is absent when no worktree can host one.
 */
export function SignInDialog({ open, api, cli, account, verifiesIdentity, firstRunNote, onGone, onClose }: SignInDialogProps) {
  const canOpenTerminal = useCanOpenSignInTerminal();
  const [terminalError, setTerminalError] = useState("");

  async function check(): Promise<AccountSummary> {
    let next: AccountSummary;
    try {
      next = await api.refreshAccount(cli, account.id);
    } catch (e) {
      if (isAccountError(e, "duplicate_account") || isAccountError(e, "account_not_found")) {
        useServerStore.getState().applyAccountRemoved(cli, account.id);
        onGone?.(apiErrorText(e, "Something went wrong."));
        onClose();
      }
      throw e;
    }
    useServerStore.getState().applyAccountUpdated(next);
    if (next.pending !== true && next.auth !== "signed_out") onClose();
    return next;
  }

  async function openTerminal() {
    setTerminalError("");
    try {
      await openSignInTerminal(api, cli, account.id);
      onClose();
    } catch (e) {
      setTerminalError(apiErrorText(e, "Couldn't start the sign-in."));
    }
  }

  return (
    <Dialog
      open={open}
      title={`Sign in to ${accountName(account)}`}
      onClose={onClose}
      cardClassName="accounts-dialog-card"
      overlayClassName="dialog-overlay--flush"
    >
      <div className="accounts-dialog__panel">
        <AccountChip account={account} variant="row" />
        <SignInSteps
          account={account}
          verifiesIdentity={verifiesIdentity}
          onCheck={check}
          onOpenTerminal={() => void openTerminal()}
          canOpenTerminal={canOpenTerminal}
        />
        {firstRunNote ? <p className="accounts-dialog__help">{firstRunNote}</p> : null}
        {terminalError ? (
          <div className="accounts-dialog__error" role="alert">
            {terminalError}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
