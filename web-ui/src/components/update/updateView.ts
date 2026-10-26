import type { UpdateStatus } from "@/api/types";
import { installLabel } from "./installProgress";

/**
 * Pure derivations of what the update UI shows, from the daemon's
 * `UpdateStatus`. The chip, the dialog and Settings > Updates all read these,
 * so "when does the chip show?" and "which dialog state is this?" each have one
 * answer. Wire versions (`current`, `latest`, `skipped`, `failedVersion`, ...)
 * carry no `v` prefix; only `formatVersion` tolerates one.
 */

const SEMVER = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** True when `version` is a release version (a dev build is not). */
export function isSemver(version: string): boolean {
  return SEMVER.test(version);
}

/** Versions are always shown with a `v` prefix; dev builds are shown verbatim. */
export function formatVersion(version: string): string {
  return SEMVER.test(version) ? `v${version.replace(/^v/, "")}` : version;
}

/**
 * An install replaced only OTHER copies (e.g. a curl CLI next to a Tauri-hosted
 * daemon): `lastResult.updated` is set but there is no `restartPending` and no
 * manual step. The running version never changes, so without this the dialog and
 * chip would keep offering the same update.
 */
export function isInstalledDone(status: UpdateStatus): boolean {
  const r = status.lastResult;
  return Boolean(
    r && status.latest && r.version === status.latest && r.updated.length > 0 && r.manual.length === 0,
  );
}

/** The release on offer is one the user chose to skip. */
export function isLatestSkipped(status: UpdateStatus): boolean {
  return Boolean(status.latest) && status.skipped.includes(status.latest!);
}

/**
 * After a rollback, retrying only makes sense when the failed version is the
 * release currently on offer. Twin of `rolled_back_retry` in
 * `rust/vst-cli/src/commands/update.rs`; keep the two in step.
 */
export function rolledBackRetry(status: UpdateStatus): boolean {
  return Boolean(status.rolledBack && status.latest && status.latest === status.rolledBack.failedVersion);
}

/** A restart is pending for the very release that is on offer (nothing left to install). */
export function restartPendingIsLatest(status: UpdateStatus): boolean {
  return Boolean(status.restartPending) && status.restartPending!.version === status.latest;
}

export type ChipState = "installing" | "restart" | "rolled-back" | "available";

export interface ChipView {
  state: ChipState;
  label: string;
  ariaLabel: string;
  /** Show the inline "skip this version" button (available chip, installers only). */
  showSkip: boolean;
}

/**
 * What the TopBar chip shows, or null for nothing. Priority:
 * installing > restart pending > rolled back > update available. "Remind me
 * later" hides the available chip for that version only (session-local).
 */
export function chipView(
  status: UpdateStatus | null,
  canInstall: boolean,
  remindedFor: string | null,
): ChipView | null {
  if (!status) return null;
  const latest = status.latest ?? "";

  if (status.install) {
    const label =
      status.install.stage === "downloading"
        ? `Updating… ${status.install.pct}%`
        : installLabel(status.install);
    const ariaLabel =
      status.install.stage === "downloading"
        ? `Updating to vibe-station ${formatVersion(latest)}, ${status.install.pct} percent complete. Open update details`
        : `Updating to vibe-station ${formatVersion(latest)}: ${label} Open update details`;
    return { state: "installing", label, ariaLabel, showSkip: false };
  }
  if (status.restartPending) {
    const ver = formatVersion(status.restartPending.version);
    return status.restartPending.kind === "app"
      ? {
          state: "restart",
          label: "Quit & relaunch to finish",
          ariaLabel: `Update ${ver} installed. Quit and relaunch vibe-station to finish. Open update details`,
          showSkip: false,
        }
      : {
          state: "restart",
          label: `Restart to finish ${ver}`,
          ariaLabel: `Update ${ver} installed. Restart to finish. Open update details`,
          showSkip: false,
        };
  }
  if (status.rolledBack) {
    const ver = formatVersion(status.rolledBack.failedVersion);
    return {
      state: "rolled-back",
      label: `${ver} failed to start`,
      ariaLabel: `vibe-station ${ver} failed to start and was rolled back. Open update settings`,
      showSkip: false,
    };
  }
  if (
    status.updateAvailable &&
    latest &&
    !isInstalledDone(status) &&
    !isLatestSkipped(status) &&
    remindedFor !== latest
  ) {
    return {
      state: "available",
      label: `Update ${formatVersion(latest)}`,
      ariaLabel: `Update available: vibe-station ${formatVersion(latest)}. Open update details`,
      showSkip: canInstall,
    };
  }
  return null;
}

export type DialogState =
  | "no_asset"
  | "installing"
  | "restart_pending"
  | "manual"
  | "done"
  | "error"
  | "available";

/**
 * Which body the update dialog shows. First match wins, in this order:
 * no prebuilt asset, install running, restart pending, manual steps,
 * installed-elsewhere "done", install failure, then the plain "available" view.
 */
export function dialogState(status: UpdateStatus): DialogState {
  if (status.noAsset) return "no_asset";
  if (status.install) return "installing";
  if (status.restartPending) return "restart_pending";
  if (status.lastResult && status.lastResult.manual.length > 0) return "manual";
  if (isInstalledDone(status)) return "done";
  if (status.lastError?.kind === "install") return "error";
  return "available";
}

/** The dialog's heading. */
export function dialogTitle(status: UpdateStatus): string {
  const latest = formatVersion(status.latest ?? "");
  if (status.install) return `Updating to ${latest}`;
  if (status.restartPending) return `${formatVersion(status.restartPending.version)} installed`;
  if (isInstalledDone(status)) return `${latest} installed`;
  if (status.lastResult && status.lastResult.manual.length > 0) {
    return status.lastResult.updated.length > 0 ? `${latest} installed` : `Update to ${latest}`;
  }
  return `vibe-station ${latest} available`;
}
