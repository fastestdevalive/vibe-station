import { useEffect, useState } from "react";
import {
  fetchUpdateStatus,
  setAutoCheck,
  installUpdate,
  skipUpdate,
  unskipUpdate,
} from "@/api/update";
import type { UpdateStatus } from "@/api/types";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import { SectionHeader } from "./SectionHeader";
import { ChangelogView } from "@/components/update/ChangelogView";
import { METHOD_LABEL } from "@/components/update/methodLabel";
import { installLabel, installPct } from "@/components/update/installProgress";
import { actionErrorCopy } from "@/components/update/errorRecovery";
import {
  formatVersion,
  isLatestSkipped,
  isSemver,
  restartPendingIsLatest,
  rolledBackRetry,
} from "@/components/update/updateView";
import {
  CheckError,
  InstallErrorBox,
  OfferRow,
  RestartPendingBanner,
  RolledBackBanner,
  Row,
} from "./UpdateSettingParts";
import "@/styles/update.css";
import { forceFloor } from "./forceFloor";

/** Mirrors `FORCE_FLOOR` in rust/vst-daemon/src/update/service/mod.rs (a Rust test keeps them equal): a forced check inside this window returns the cached snapshot. */
const FORCE_FLOOR_MS = 30_000;

/** Settings > Updates: version info, check, install/skip actions, changelog, errors and recovery. */
export function UpdateSetting() {
  const status = useUpdateStore((s) => s.status);
  const canInstall = useUpdateStore((s) => s.canInstall);
  const [checking, setChecking] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [justChecked, setJustChecked] = useState(false);
  const [floorWaitS, setFloorWaitS] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);

  // "checked just now" is only true for a minute.
  useEffect(() => {
    if (!justChecked) return;
    const id = setTimeout(() => setJustChecked(false), 60_000);
    return () => clearTimeout(id);
  }, [justChecked]);

  // The "try again in N s" hint clears itself once the floor has passed.
  useEffect(() => {
    if (floorWaitS <= 0) return;
    const id = setTimeout(() => setFloorWaitS(0), floorWaitS * 1000);
    return () => clearTimeout(id);
  }, [floorWaitS]);

  async function check() {
    const sinceForced = Date.now() - forceFloor.lastForcedAt;
    if (sinceForced < FORCE_FLOOR_MS) {
      // Inside the daemon's floor a forced check is a no-op; say so.
      setFloorWaitS(Math.ceil((FORCE_FLOOR_MS - sinceForced) / 1000));
      return;
    }
    forceFloor.lastForcedAt = Date.now();
    setChecking(true);
    try {
      const resp = await fetchUpdateStatus(true);
      useUpdateStore.getState().setFromCheck(resp);
      setJustChecked(true);
    } catch {
      /* keep the last known snapshot */
    } finally {
      setChecking(false);
    }
  }

  async function toggleAuto(on: boolean) {
    setActionError(null);
    try {
      useUpdateStore.getState().setStatus(await setAutoCheck(on));
    } catch (err) {
      setActionError(actionErrorCopy(err));
    }
  }

  /** Run a request that replaces the status snapshot, surfacing its error copy. */
  async function act(request: () => Promise<UpdateStatus>) {
    setActionBusy(true);
    setActionError(null);
    try {
      useUpdateStore.getState().setStatus(await request());
    } catch (err) {
      setActionError(actionErrorCopy(err));
    } finally {
      setActionBusy(false);
    }
  }
  const handleInstall = () => void act(installUpdate);
  const handleSkip = (version: string) => void act(() => skipUpdate(version));
  const handleUnskip = (version: string) => void act(() => unskipUpdate(version));

  if (!status) {
    return (
      <div>
        <SectionHeader title="Updates" />
        <div className="update-setting__muted">Loading…</div>
      </div>
    );
  }

  const devBuild = !isSemver(status.current);
  const fromSource = status.installMethod === "unknown";
  const latest = status.latest ?? "";
  const upToDate = !status.updateAvailable && !status.lastError && !rolledBackRetry(status);

  return (
    <div className="update-setting">
      <SectionHeader title="Updates" description="Check for new versions of Vibe Station." />

      <Row label="Current version">{formatVersion(status.current)}</Row>
      <Row label="Installed via">{METHOD_LABEL[status.installMethod]}</Row>
      {status.targets.length > 0 && (
        <Row label="Targets">
          <ul className="update-setting__targets">
            {status.targets.map((t) => (
              <li key={`${t.method}:${t.path}`}>
                {t.path}
                {t.version ? ` (${formatVersion(t.version)})` : ""}
                {t.auto ? "" : " — manual"}
              </li>
            ))}
          </ul>
        </Row>
      )}
      <Row label="Last checked">{status.checkedAt ? new Date(status.checkedAt).toLocaleString() : "Never"}</Row>

      {devBuild && (
        <div className="update-setting__muted update-setting__note">Development build — updates unavailable</div>
      )}
      {!devBuild && fromSource && (
        <div className="update-setting__muted update-setting__note">
          Installed from source — update manually
          {status.releaseUrl && (
            <>
              {" "}·{" "}
              <a href={status.releaseUrl} target="_blank" rel="noopener noreferrer" className="update-setting__link">
                View release ↗
              </a>
            </>
          )}
        </div>
      )}

      {/* Check button and Up to date badge */}
      {!devBuild && (
        <div className="update-setting__check-row">
          <button type="button" className="btn btn--ghost" disabled={checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check for updates"}
          </button>
          {floorWaitS > 0 && (
            <span role="status" className="update-setting__muted">
              Checked a few seconds ago — try again in {floorWaitS} s.
            </span>
          )}
          {justChecked && upToDate && floorWaitS === 0 && (
            <span className="update-setting__ok">You're up to date — checked just now</span>
          )}
        </div>
      )}

      {status.restartPending && <RestartPendingBanner status={status} canInstall={canInstall} />}

      {status.rolledBack && (
        <RolledBackBanner
          status={status}
          canInstall={canInstall}
          busy={actionBusy}
          onInstall={handleInstall}
          onSkip={handleSkip}
        />
      )}

      {/* In-flight install progress */}
      {status.install && (
        <div className="update-setting__block">
          <div className="update-setting__progress-head">
            <span>{installLabel(status.install)}</span>
          </div>
          <div
            className="update-dialog__progress-bar"
            role="progressbar"
            aria-label="Update progress"
            aria-valuenow={installPct(status.install)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="update-dialog__progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, installPct(status.install)))}%` }}
            />
          </div>
        </div>
      )}

      {/* Available / skipped version actions, with the changelog */}
      {!devBuild && status.updateAvailable && latest && !status.install && !restartPendingIsLatest(status) && (
        <div className="update-setting__block">
          <OfferRow
            status={status}
            canInstall={canInstall}
            busy={actionBusy}
            skipped={isLatestSkipped(status)}
            onInstall={handleInstall}
            onSkip={handleSkip}
            onUnskip={handleUnskip}
          />
          <ChangelogView
            changelog={status.changelog}
            behindCount={status.behindCount}
            currentVersion={status.current}
            latestVersion={status.latest}
            releaseUrl={status.releaseUrl}
          />
        </div>
      )}

      {!devBuild && <CheckError status={status} busy={checking} onRetry={() => void check()} />}

      {!devBuild && status.lastError?.kind === "install" && (
        <InstallErrorBox status={status} canInstall={canInstall} busy={actionBusy} onInstall={handleInstall} />
      )}

      {actionError && (
        <div role="alert" className="update-setting__alert">
          {actionError}
        </div>
      )}

      <label className="update-setting__auto">
        <input
          type="checkbox"
          checked={status.autoCheck}
          disabled={!canInstall}
          onChange={(e) => void toggleAuto(e.target.checked)}
        />
        Check for updates automatically
      </label>
      {!status.autoCheck && !status.checkedAt && (
        <div className="update-setting__muted update-setting__banner-note">Automatic checks are off · Never checked</div>
      )}
    </div>
  );
}
