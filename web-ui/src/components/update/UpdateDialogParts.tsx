import type { ImpactItem, InstallProgress, InstallStage } from "@/api/types";
import { INSTALL_STAGES, installLabel, installPct } from "./installProgress";

/** Active sessions a daemon restart would interrupt. */
export function RestartImpactBox({ impact }: { impact: ImpactItem[] }) {
  if (impact.length === 0) return null;
  return (
    <div className="update-dialog__impact-box" role="alert">
      <span className="update-dialog__impact-title">Restarting will interrupt:</span>
      <ul>
        {impact.map((item) => {
          const label = item.name ?? item.sessionId;
          const detail =
            item.kind === "working"
              ? "agent is working"
              : item.kind === "pty"
                ? "terminal process is attached"
                : "request is in flight";
          return (
            <li key={item.sessionId}>
              {label} ({detail})
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Stage name + progress bar for an in-flight install. */
export function InstallProgressBody(progress: InstallProgress) {
  const { startedBy } = progress;
  const pct = installPct(progress);
  return (
    <div className="update-dialog__body">
      {startedBy === "cli" ? <div className="update-dialog__notice">Started from CLI</div> : null}
      <div className="update-dialog__stage-row">
        <span className="update-dialog__stage-name">
          {installLabel(progress)}
        </span>
      </div>
      <div
        className="update-dialog__progress-bar"
        role="progressbar"
        aria-label="Update progress"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="update-dialog__progress-fill"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <InstallStageLog stage={progress.stage} />
    </div>
  );
}

const DONE_LABEL: Record<InstallStage, string> = {
  preflight: "Checked prerequisites",
  downloading: "Downloaded",
  verifying: "Verified checksum",
  installing: "Installed",
};
const ACTIVE_LABEL: Record<InstallStage, string> = {
  preflight: "Checking prerequisites",
  downloading: "Downloading",
  verifying: "Verifying checksum",
  installing: "Installing",
};

/** Derived from the current stage only; deliberately not a live region (UpdateStageAnnouncer owns that). */
function InstallStageLog({ stage }: { stage: InstallStage }) {
  const current = INSTALL_STAGES.indexOf(stage);
  return (
    <ol className="update-dialog__stage-log">
      {INSTALL_STAGES.slice(0, current + 1).map((s, i) =>
        i < current ? (
          <li key={s} data-state="done">
            ✓ {DONE_LABEL[s]}
          </li>
        ) : (
          <li key={s} data-state="active" aria-current="step">
            {ACTIVE_LABEL[s]}
          </li>
        ),
      )}
    </ol>
  );
}
