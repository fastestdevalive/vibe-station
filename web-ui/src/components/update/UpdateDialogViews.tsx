import { InstallRecoveryActions, recoveryFor } from "./errorRecovery";
import { InstallProgressBody } from "./UpdateDialogParts";
import { InstalledDoneBody } from "./UpdateDoneState";
import { ChangelogView } from "./ChangelogView";
import { METHOD_LABEL } from "./methodLabel";
import { formatVersion } from "./updateView";
import type { DialogCtx, DialogView } from "./dialogContext";

function Changelog({ status }: Pick<DialogCtx, "status">) {
  return (
    <ChangelogView
      changelog={status.changelog}
      behindCount={status.behindCount}
      currentVersion={status.current}
      latestVersion={status.latest}
      releaseUrl={status.releaseUrl}
    />
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="btn btn--ghost" onClick={onClose}>
      Close
    </button>
  );
}

/** No prebuilt asset for this platform: point at the release page. */
export function noAssetView({ status, onClose }: DialogCtx): DialogView {
  return {
    body: (
      <div className="update-dialog__body">
        <p className="update-dialog__sub">
          No prebuilt {formatVersion(status.latest ?? "")} for {status.platform}.
        </p>
        <Changelog status={status} />
      </div>
    ),
    footer: (
      <div className="update-dialog__footer">
        <CloseButton onClose={onClose} />
        {status.releaseUrl ? (
          <a href={status.releaseUrl} target="_blank" rel="noopener noreferrer" className="btn btn--primary">
            View release
          </a>
        ) : null}
      </div>
    ),
  };
}

/** An install is running: preflight, downloading, verifying or installing. */
export function installingView({ status, canInstall, cancelling, onCancel, onClose }: DialogCtx): DialogView {
  const { stage, pct, startedBy } = status.install!;
  return {
    body: <InstallProgressBody stage={stage} pct={pct} startedBy={startedBy} />,
    footer: (
      <div className="update-dialog__footer">
        {stage === "downloading" && canInstall ? (
          <button type="button" className="btn btn--danger" disabled={cancelling} onClick={onCancel}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        ) : (
          <CloseButton onClose={onClose} />
        )}
      </div>
    ),
  };
}

/** Only non-running copies were updated, so there is nothing left to do. */
export function installedDoneView({ status, copiedCommand, onCopyCommand, onClose }: DialogCtx): DialogView {
  return {
    body: <InstalledDoneBody status={status} copiedCommand={copiedCommand} onCopyCommand={onCopyCommand} />,
    footer: (
      <div className="update-dialog__footer">
        <button type="button" className="btn btn--primary" onClick={onClose}>
          Done
        </button>
      </div>
    ),
  };
}

/** The install failed: per-reason message and recovery actions. */
export function installErrorView({ status, canInstall, busy, onUpdateNow, onClose }: DialogCtx): DialogView {
  const installError = status.lastError!;
  const recovery = recoveryFor(installError);
  return {
    body: (
      <div className="update-dialog__body">
        <div className="update-dialog__error-box" role="alert">
          <strong>Update failed</strong>
          <p>{recovery.message}</p>
          {recovery.detail ? <span className="update-dialog__muted">({recovery.detail})</span> : null}
          <span className="update-dialog__muted">
            Your current version ({formatVersion(status.current)}) is unchanged.
          </span>
        </div>
      </div>
    ),
    footer: (
      <div className="update-dialog__footer">
        <InstallRecoveryActions
          status={status}
          error={installError}
          canInstall={canInstall}
          busy={busy}
          onRetry={onUpdateNow}
          extra={<CloseButton onClose={onClose} />}
        />
      </div>
    ),
  };
}

/** An update is on offer: targets, changelog, and Skip / Remind / Update now. */
export function availableView({
  status,
  canInstall,
  busy,
  cancelledElsewhere,
  onUpdateNow,
  onSkip,
  onRemindLater,
  onClose,
}: DialogCtx): DialogView {
  const autoTargets = status.targets.filter((t) => t.auto);
  const manualTargets = status.targets.filter((t) => !t.auto);
  return {
    body: (
      <div className="update-dialog__body">
        <p className="update-dialog__sub">
          You're on {formatVersion(status.current)} · {METHOD_LABEL[status.installMethod]}
        </p>

        {!canInstall ? (
          <div className="update-dialog__readonly-notice">Update available — install from your computer</div>
        ) : null}

        {cancelledElsewhere ? (
          <div className="update-dialog__notice" role="status">
            Cancelled from another client
          </div>
        ) : null}

        {status.targets.length > 0 ? (
          <div className="update-dialog__targets">
            <span className="update-dialog__targets-header">Will update:</span>
            <ul>
              {autoTargets.map((t) => (
                <li key={`${t.method}:${t.path}`}>
                  {t.path} ({t.method})
                </li>
              ))}
              {manualTargets.map((t) => (
                <li key={`${t.method}:${t.path}`}>
                  {t.path} ({t.method}) — update manually
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <Changelog status={status} />
      </div>
    ),
    footer: (
      <div className="update-dialog__footer">
        {canInstall ? (
          <>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={onSkip}>
              Skip this version
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={onRemindLater}>
              Remind me later
            </button>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={onUpdateNow}>
              {busy ? "Starting…" : "Update now"}
            </button>
          </>
        ) : (
          <CloseButton onClose={onClose} />
        )}
      </div>
    ),
  };
}
