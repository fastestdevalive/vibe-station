import { useEffect, useState, type ReactNode } from "react";
import type { UpdateStatus } from "@/api/types";
import { RestartImpactBox } from "@/components/update/UpdateDialogParts";
import { InstallRecoveryActions, recoveryFor, retryDelayMs } from "@/components/update/errorRecovery";
import { useDaemonRestart } from "@/components/update/useDaemonRestart";
import { formatVersion, rolledBackRetry } from "@/components/update/updateView";
import "@/styles/update.css";

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="update-setting__row">
      <span className="update-setting__row-label">{label}</span>
      <span className="update-setting__row-value">{children}</span>
    </div>
  );
}

/** Retryable "could not check" error; Retry waits out a rate-limit's retry-after. */
export function CheckError({ status, onRetry, busy }: { status: UpdateStatus; onRetry: () => void; busy: boolean }) {
  const err = status.lastError;
  const [wait, setWait] = useState(() => retryDelayMs(err?.retryAfter));
  useEffect(() => {
    const ms = retryDelayMs(err?.retryAfter);
    setWait(ms);
    if (ms <= 0) return;
    const id = setTimeout(() => setWait(0), ms);
    return () => clearTimeout(id);
  }, [err?.retryAfter]);

  if (!err || err.kind !== "check") return null;
  if (err.reason !== "offline" && err.reason !== "rate_limited" && err.reason !== "github_error") return null;
  const text =
    err.reason === "offline"
      ? "Can't reach GitHub — check your connection."
      : err.reason === "rate_limited"
        ? wait > 0 && err.retryAfter
          ? `GitHub rate limit — try after ${new Date(err.retryAfter).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
          : "GitHub rate limit reached — try again later."
        : "GitHub returned an error while checking for updates.";
  return (
    <div role="alert" className="update-setting__check-row">
      <span className="update-setting__check-error-text">{text}</span>
      <button
        type="button"
        className="btn btn--ghost update-setting__small-btn"
        disabled={busy || wait > 0}
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}

/** "Restart to finish" banner; owns its own restart flow (dry-run impact, confirm, errors). */
export function RestartPendingBanner({ status, canInstall }: { status: UpdateStatus; canInstall: boolean }) {
  const pending = status.restartPending!;
  const restart = useDaemonRestart();
  const { impact, confirming, busy, error } = restart;
  return (
    <div className="update-setting__banner">
      <div className="update-setting__banner-title">
        {pending.kind === "app" ? "Quit & relaunch to finish" : "Restart to finish"} {formatVersion(pending.version)}
      </div>
      {pending.kind === "app" ? (
        <div className="update-setting__muted update-setting__banner-note">
          Quit & relaunch vibe-station to finish.
        </div>
      ) : (
        <div className="update-setting__banner-body">
          {impact && impact.length > 0 && (
            <div className="update-setting__banner-impact">
              <RestartImpactBox impact={impact} />
            </div>
          )}
          {error && (
            <div role="alert" className="update-setting__muted update-setting__banner-error">
              {error.message}
            </div>
          )}
          {canInstall && !error?.terminal && (
            <div className="update-setting__banner-actions">
              {confirming ? (
                <>
                  <button type="button" className="btn btn--ghost" onClick={restart.cancelConfirm}>
                    Later
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={busy}
                    onClick={() => void restart.restart(true)}
                  >
                    {busy ? "Restarting…" : "Restart anyway"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => void restart.restart(false)}
                >
                  {busy ? "Restarting…" : error ? "Retry" : "Restart daemon"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface SettingActions {
  busy: boolean;
  onInstall: () => void;
  onSkip: (version: string) => void;
}

/** "vX failed to start - rolled back" banner with Retry / Skip / View release. */
export function RolledBackBanner({
  status,
  canInstall,
  busy,
  onInstall,
  onSkip,
}: { status: UpdateStatus; canInstall: boolean } & SettingActions) {
  const rolledBack = status.rolledBack!;
  return (
    <div className="update-setting__banner">
      <div className="update-setting__banner-title update-setting__banner-title--warn">
        {formatVersion(rolledBack.failedVersion)} failed to start — rolled back to {formatVersion(status.current)}
      </div>
      <div className="update-setting__muted update-setting__banner-note">
        Your sessions are intact. Manual restore (if needed): mv .vst.prev vst
      </div>
      {status.noAsset && (
        <div className="update-setting__muted update-setting__banner-note">
          No prebuilt {formatVersion(status.latest || rolledBack.failedVersion)} for {status.platform}.
        </div>
      )}
      <div className="update-setting__banner-actions update-setting__banner-actions--spaced">
        {canInstall && (
          <>
            {status.noAsset || !rolledBackRetry(status) ? null : (
              <button type="button" className="btn btn--primary" disabled={busy} onClick={onInstall}>
                Retry install
              </button>
            )}
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => onSkip(rolledBack.failedVersion)}
            >
              Skip this version
            </button>
          </>
        )}
        {status.releaseUrl && (
          <a href={status.releaseUrl} target="_blank" rel="noopener noreferrer" className="btn btn--ghost">
            View release
          </a>
        )}
      </div>
    </div>
  );
}

/** Failed-install row with the per-reason message and recovery actions. */
export function InstallErrorBox({
  status,
  canInstall,
  busy,
  onInstall,
}: { status: UpdateStatus; canInstall: boolean } & Omit<SettingActions, "onSkip">) {
  const error = status.lastError!;
  const recovery = recoveryFor(error);
  return (
    <div className="update-setting__error-box">
      <div className="update-setting__error-title">
        Update failed: {recovery.message}
        {recovery.detail ? <span className="update-setting__error-detail"> ({recovery.detail})</span> : null}
      </div>
      <div className="update-setting__error-actions">
        <InstallRecoveryActions
          status={status}
          error={error}
          canInstall={canInstall}
          busy={busy}
          onRetry={onInstall}
        />
      </div>
    </div>
  );
}

/** The "version X is available / skipped / has no asset" row. */
export function OfferRow({
  status,
  canInstall,
  busy,
  skipped,
  onInstall,
  onSkip,
  onUnskip,
}: {
  status: UpdateStatus;
  canInstall: boolean;
  busy: boolean;
  skipped: boolean;
  onInstall: () => void;
  onSkip: (version: string) => void;
  onUnskip: (version: string) => void;
}) {
  const latest = status.latest!;
  if (status.noAsset) {
    return (
      <div className="update-setting__offer">
        <span className="update-setting__offer-text">
          No prebuilt {formatVersion(latest)} for {status.platform}.
        </span>
        {status.releaseUrl && (
          <a className="btn btn--ghost" href={status.releaseUrl} target="_blank" rel="noopener noreferrer">
            View release
          </a>
        )}
      </div>
    );
  }
  if (skipped) {
    return (
      <div className="update-setting__offer">
        <span className="update-setting__offer-text update-setting__offer-text--muted">
          {formatVersion(latest)} skipped
        </span>
        {canInstall && (
          <>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={onInstall}>
              Update anyway
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => onUnskip(latest)}>
              Unskip
            </button>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="update-setting__offer">
      <span className="update-setting__offer-text">Version {formatVersion(latest)} is available.</span>
      {canInstall && (
        <>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={onInstall}>
            Update
          </button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => onSkip(latest)}>
            Skip
          </button>
        </>
      )}
    </div>
  );
}
