import { useCallback, useEffect, useId, useState } from "react";
import type { ApiInstance } from "@/api";
import { isAccountError } from "@/api/errors";
import type {
  AccountFolderBody,
  AccountSummary,
  SupportedCli,
  ValidateAccountPathResponse,
} from "@/api/types";
import { Dialog } from "@/components/dialogs/Dialog";
import { useServerStore } from "@/hooks/useServerStore";
import { cliDisplayName } from "@/lib/cliNames";
import { apiErrorText } from "@/lib/apiErrorText";
import { ACCOUNT_WORDS } from "@/lib/accounts";
import "./accounts.css";
import { AddFolderStage } from "./AddFolderStage";
import { AccountChip } from "./AccountChip";
import { SignInSteps } from "./SignInSteps";
import { useApiKeyStage } from "./useApiKeyStage";
import { openSignInTerminal, useCanOpenSignInTerminal } from "./signInTerminal";

/** Stages of the dialog: choose a folder, add it, then finish (see plan B2b.1). */
type Stage = "folder" | "adding" | "added" | "waiting" | "apikey";

/** How the folder is chosen: a new managed folder, or an existing one. */
type FolderMode = "create" | "choose";

const PREVIEW_DEBOUNCE_MS = 300;

interface AddAccountDialogProps {
  open: boolean;
  api: ApiInstance;
  cli: SupportedCli;
  onClose: () => void;
  /** Start in "Choose a folder" with this path filled in. */
  initialDir?: string;
}

/** The name-taken copy (plan B2.3). */
function labelTakenMessage(label: string, cliName: string): string {
  return `${label} is already a ${cliName} account name.`;
}

/** Server text for a refused call; `label_taken` gets the harness-named copy. */
function refusalText(e: unknown, label: string, cliName: string): string {
  return isAccountError(e, "label_taken")
    ? labelTakenMessage(label, cliName)
    : apiErrorText(e, "Something went wrong.");
}

/**
 * "Add account" dialog (plan B2b.1): folder -> adding -> added | waiting, or
 * an API-key account. The dialog reads its own row from `useServerStore`, so a
 * completion the daemon pushes flips it to "added" without polling. The API
 * key is write-only: cleared the moment the request starts, never rendered.
 */
export function AddAccountDialog({ open, api, cli, onClose, initialDir }: AddAccountDialogProps) {
  const cliName = cliDisplayName(cli.id);
  const link = cli.accountLink ?? null;
  const verifiesIdentity = link?.verifiesIdentity !== false;
  const groupId = useId();
  const labelId = `${groupId}-label`;
  const doneNameId = `${groupId}-done-name`;

  const canOpenTerminal = useCanOpenSignInTerminal();

  const [stage, setStage] = useState<Stage>("folder");
  const [mode, setMode] = useState<FolderMode>("create");
  const [label, setLabel] = useState("");
  const [dir, setDir] = useState("");
  const [chosen, setChosen] = useState<ValidateAccountPathResponse | null>(null);
  const [preview, setPreview] = useState<ValidateAccountPathResponse | null>(null);
  const [refusal, setRefusal] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [added, setAdded] = useState<AccountSummary | null>(null);
  const [doneName, setDoneName] = useState("");

  // The dialog's own row: the store is the source of truth once the account exists.
  const storeRow = useServerStore((s) =>
    accountId ? s.accounts.find((a) => a.cli === cli.id && a.id === accountId) : undefined,
  );
  const current = storeRow ?? added;
  const keyStage = useApiKeyStage({
    api,
    cliId: cli.id,
    open,
    onAdded: onClose,
    describeError: (e, name) => refusalText(e, name, cliName),
  });

  // Every open starts clean: no stale stage, folder, name or key.
  useEffect(() => {
    if (!open) return;
    setStage("folder");
    setMode(initialDir ? "choose" : "create");
    setLabel("");
    setDir(initialDir ?? "");
    setChosen(null);
    setPreview(null);
    setRefusal("");
    setError("");
    setBusy(false);
    setAccountId(null);
    setAdded(null);
    setDoneName("");
  }, [open, initialDir]);

  const enterAdded = useCallback((acct: AccountSummary) => {
    setAdded(acct);
    setAccountId(acct.id);
    setDoneName(acct.email ?? "");
    setError("");
    setStage("added");
  }, []);

  // A confirmed identity (pushed by the daemon or returned by a check) completes the flow.
  useEffect(() => {
    if (stage === "waiting" && storeRow && storeRow.pending !== true) enterAdded(storeRow);
  }, [stage, storeRow, enterAdded]);

  // Create mode: a read-only preview of the managed folder, debounced; a refusal blocks Continue.
  useEffect(() => {
    if (!open || stage !== "folder" || mode !== "create") return undefined;
    let live = true;
    const timer = setTimeout(() => {
      api
        .validateAccountPath({ cli: cli.id, mode: "create", label: label.trim() || undefined })
        .then((next) => {
          if (!live) return;
          setPreview(next);
          setRefusal("");
        })
        .catch((e: unknown) => {
          if (!live) return;
          setPreview(null);
          setRefusal(refusalText(e, label.trim(), cliName));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, cli.id, cliName, label, mode, open, stage]);

  async function addFolder() {
    const request: AccountFolderBody =
      mode === "create"
        ? { cli: cli.id, mode: "create", label: label.trim() || undefined }
        : { cli: cli.id, mode: "choose", dir: dir.trim() };
    setBusy(true);
    setError("");
    setStage("adding");
    try {
      const res = await api.addFolderAccount(request);
      useServerStore.getState().applyAccountUpdated(res.account);
      setAccountId(res.account.id);
      setAdded(res.account);
      if (res.signedIn) enterAdded(res.account);
      else setStage("waiting");
    } catch (e) {
      setStage("folder");
      setError(refusalText(e, label.trim(), cliName));
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain(): Promise<AccountSummary> {
    if (!accountId) throw new Error("No account to check.");
    let next: AccountSummary;
    try {
      next = await api.refreshAccount(cli.id, accountId);
    } catch (e) {
      if (isAccountError(e, "duplicate_account") || isAccountError(e, "account_not_found")) {
        // The daemon dropped the pending row: back to the folder step with the reason.
        useServerStore.getState().applyAccountRemoved(cli.id, accountId);
        setAccountId(null);
        setAdded(null);
        setStage("folder");
        setError(apiErrorText(e, "Something went wrong."));
      }
      throw e;
    }
    useServerStore.getState().applyAccountUpdated(next);
    return next;
  }

  async function openInTerminal() {
    if (!accountId) return;
    setError("");
    try {
      await openSignInTerminal(api, cli.id, accountId);
    } catch (e) {
      setError(apiErrorText(e, "Something went wrong."));
    }
  }

  // Cancel while waiting removes the pending row (its folder only when we made it).
  async function cancelWaiting() {
    if (busy) return;
    if (!accountId) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await api.removeAccount(cli.id, accountId);
      useServerStore.getState().applyAccountRemoved(cli.id, accountId);
      onClose();
    } catch (e) {
      setError(apiErrorText(e, "Something went wrong."));
    } finally {
      setBusy(false);
    }
  }

  // Done renames only when the name was edited to something non-empty.
  async function finishAdded() {
    const name = doneName.trim();
    if (!current || !name || name === (current.email ?? "")) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await api.renameAccount(cli.id, current.id, name);
      useServerStore.getState().applyAccountUpdated(next);
      onClose();
    } catch (e) {
      setError(refusalText(e, name, cliName));
    } finally {
      setBusy(false);
    }
  }

  // The exact path only when the name decides it; otherwise the real folder is named after the id.
  let createPathLine = "";
  if (preview) {
    createPathLine = label.trim()
      ? `Will create ${preview.dir}`
      : `Will create a folder in ${preview.dir.slice(0, preview.dir.lastIndexOf("/"))}/`;
  }

  const canContinue = mode === "create" ? refusal === "" : chosen !== null;

  const cancelButton = (
    <button
      type="button"
      onClick={() => (stage === "waiting" ? void cancelWaiting() : onClose())}
      disabled={busy || keyStage.busy}
    >
      Cancel
    </button>
  );
  const footer = (
    <>
      {stage === "apikey" ? (
        <button type="button" disabled={busy || keyStage.busy} onClick={() => setStage("folder")}>
          Back
        </button>
      ) : null}
      {stage !== "added" ? cancelButton : null}
      {stage === "folder" ? (
        <button type="button" disabled={busy || !canContinue} onClick={() => void addFolder()}>
          Continue
        </button>
      ) : null}
      {stage === "added" ? (
        <button type="button" disabled={busy} onClick={() => void finishAdded()}>
          Done
        </button>
      ) : null}
      {stage === "apikey" ? (
        <button
          type="button"
          disabled={busy || keyStage.busy || !keyStage.canSubmit}
          onClick={() => void keyStage.submit()}
        >
          Add account
        </button>
      ) : null}
    </>
  );

  return (
    <Dialog
      open={open}
      title={`Add ${cliName} account`}
      onClose={onClose}
      footer={footer}
      cardClassName="accounts-dialog-card"
      overlayClassName="dialog-overlay--flush"
    >
      {stage === "folder" ? (
        <AddFolderStage
          api={api}
          cli={cli}
          groupId={groupId}
          labelId={labelId}
          mode={mode}
          onMode={setMode}
          label={label}
          onLabel={setLabel}
          createPathLine={createPathLine}
          refusal={refusal}
          error={error}
          dir={dir}
          onDir={setDir}
          onChosen={setChosen}
          cliName={cliName}
          onUseApiKey={link?.supportsApiKey ? () => setStage("apikey") : null}
        />
      ) : null}

      {stage === "adding" ? (
        <p className="accounts-dialog__status" role="status">
          Adding account…
        </p>
      ) : null}

      {stage === "added" && current ? (
        <div className="accounts-dialog__panel">
          <p className="accounts-dialog__status" role="status">
            Account added
          </p>
          <AccountChip account={current} variant="row" showPlan detail={current.dir} />
          <label className="accounts-dialog__label" htmlFor={doneNameId}>
            Name (optional)
          </label>
          <input
            id={doneNameId}
            className="accounts-dialog__input"
            value={doneName}
            onChange={(e) => setDoneName(e.target.value)}
          />
          {link?.firstRunNote ? (
            <p className="accounts-dialog__help">{link.firstRunNote}</p>
          ) : null}
          {error ? (
            <div className="accounts-dialog__error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}

      {stage === "waiting" && current ? (
        <div className="accounts-dialog__panel">
          <p className="accounts-dialog__status" role="status">
            {ACCOUNT_WORDS.pending}
          </p>
          <SignInSteps
            account={current}
            verifiesIdentity={verifiesIdentity}
            onCheck={checkAgain}
            onOpenTerminal={() => void openInTerminal()}
            canOpenTerminal={canOpenTerminal}
          />
          {link?.firstRunNote ? <p className="accounts-dialog__help">{link.firstRunNote}</p> : null}
          {error ? (
            <div className="accounts-dialog__error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}

      {stage === "apikey" ? keyStage.panel : null}
    </Dialog>
  );
}
