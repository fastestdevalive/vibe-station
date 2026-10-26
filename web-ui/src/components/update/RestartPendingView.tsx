import { RestartImpactBox } from "./UpdateDialogParts";
import { ManualStepsBlock } from "./ManualStepsBlock";
import type { DialogCtx, DialogView } from "./dialogContext";

/** Installed; the daemon (or the desktop app) must restart to finish. */
export function restartPendingView({
  status,
  canInstall,
  copiedCommand,
  restart,
  onClose,
  onCopyCommand,
}: DialogCtx): DialogView {
  const isApp = status.restartPending!.kind === "app";
  const { impact, confirming, busy, error } = restart;
  const manual = status.lastResult?.manual ?? [];
  const updated = status.lastResult?.updated ?? [];

  const body = (
    <div className="update-dialog__body">
      <p className="update-dialog__sub">
        {isApp
          ? "Quit & relaunch vibe-station to finish."
          : canInstall
            ? "Restart the daemon to finish the update."
            : "Restart from your computer to finish."}
      </p>
      {error ? (
        <div className="update-dialog__error-box" role="alert">
          {error.message}
        </div>
      ) : null}
      {!isApp && canInstall && impact ? <RestartImpactBox impact={impact} /> : null}
      {manual.length > 0 ? (
        <ManualStepsBlock
          result={status.lastResult!}
          targets={status.targets}
          onCopyCommand={onCopyCommand}
          copiedCommand={copiedCommand}
        />
      ) : updated.length > 0 ? (
        <div className="update-dialog__result-list">
          <span className="update-dialog__result-title">Updated:</span>
          <ul>
            {updated.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );

  let buttons;
  if (isApp) {
    buttons = (
      <button type="button" className="btn btn--primary" onClick={onClose}>
        Done
      </button>
    );
  } else if (!canInstall || error?.terminal) {
    buttons = (
      <button type="button" className="btn btn--ghost" onClick={onClose}>
        Close
      </button>
    );
  } else if (confirming) {
    buttons = (
      <>
        <button type="button" className="btn btn--ghost" onClick={restart.cancelConfirm}>
          Later
        </button>
        <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void restart.restart(true)}>
          {busy ? "Restarting…" : "Restart anyway"}
        </button>
      </>
    );
  } else {
    buttons = (
      <>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Later
        </button>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void restart.restart(false)}>
          {busy ? "Restarting…" : error ? "Retry" : "Restart daemon"}
        </button>
      </>
    );
  }
  return { body, footer: <div className="update-dialog__footer">{buttons}</div> };
}
