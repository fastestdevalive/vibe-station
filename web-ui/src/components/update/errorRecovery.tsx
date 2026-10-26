import { useEffect, useState } from "react";
import { fetchUpdateStatus, type RestartOutcome } from "@/api/update";
import { ApiError } from "@/api/errors";
import type { UpdateError, UpdateReason, UpdateStatus } from "@/api/types";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import { ShellBlock } from "@/components/preview/ShellBlock";

/** Same script/URL the daemon names in its `permission_denied` message. */
const INSTALL_SH =
  "https://raw.githubusercontent.com/fastestdevalive/vibe-station/main/scripts/install.sh";

/** `sudo` re-install into the curl copy whose dir failed the write probe
 *  (named in the error message), or null when no curl copy matches. */
export function sudoInstallCommand(status: UpdateStatus): string | null {
  const message = status.lastError?.message ?? "";
  const dir = status.targets
    .filter((t) => t.method === "curl")
    .map((t) => t.path.replace(/\/[^/]+$/, ""))
    .find((d) => d && message.includes(`${d}:`));
  return dir ? `curl -fsSL ${INSTALL_SH} | sudo sh -s -- --install-dir ${dir}` : null;
}

/** Milliseconds until `retryAfter` (ISO or HTTP date); 0 when absent/unparseable/past. */
export function retryDelayMs(retryAfter: string | undefined): number {
  if (!retryAfter) return 0;
  const t = Date.parse(retryAfter);
  return Number.isNaN(t) ? 0 : Math.max(0, t - Date.now());
}

export type RecoveryAction = "retry" | "view_release" | "copy_sudo";

export interface Recovery {
  message: string;
  actions: RecoveryAction[];
  retryAfterMs: number;
  /** Raw daemon message, shown in parentheses when `message` is generic copy. */
  detail?: string;
}

const VERIFICATION_REASONS: UpdateReason[] = [
  "missing_checksum",
  "missing_signature",
  "bad_signature",
  "downgrade",
  "checksum_mismatch",
  "smoke_failed",
];

/** What an install failure says and which recoveries it offers. */
export function recoveryFor(error: UpdateError): Recovery {
  const retryAfterMs = retryDelayMs(error.retryAfter);
  if (error.reason === "permission_denied") {
    return { message: error.message, actions: ["copy_sudo"], retryAfterMs: 0 };
  }
  if (error.reason === "no_asset") {
    return {
      message: "No prebuilt update for this platform.",
      actions: ["view_release"],
      retryAfterMs: 0,
    };
  }
  if (VERIFICATION_REASONS.includes(error.reason)) {
    return {
      message: "Download failed verification. Nothing was changed.",
      actions: ["retry", "view_release"],
      retryAfterMs: 0,
    };
  }
  if (error.reason === "offline" || error.reason === "github_error") {
    return {
      message: "Couldn't reach GitHub.",
      actions: ["retry"],
      retryAfterMs: 0,
      detail: error.message,
    };
  }
  if (error.reason === "disk_full") {
    return {
      message: `${error.message} Retry after freeing space.`,
      actions: ["retry"],
      retryAfterMs: 0,
    };
  }
  if (error.reason === "rate_limited") {
    return { message: error.message, actions: ["retry"], retryAfterMs };
  }
  return { message: error.message, actions: ["retry"], retryAfterMs: 0 };
}

/**
 * Copy for a failed install/cancel/skip/unskip/settings call. The daemon
 * sends `{ error }`; `api/update.ts` surfaces it as `ApiError.code`.
 */
export function actionErrorCopy(err: unknown): string {
  const code = err instanceof ApiError ? err.code : undefined;
  switch (code) {
    case "not_cancellable":
      return "Too late to cancel — installing.";
    case "no_asset":
      return "No prebuilt update for this platform.";
    case "mobile_read_only":
      return "Do this from your computer — this device is read-only.";
    case "restart_in_progress":
      return "Daemon is restarting — reconnecting…";
    case "invalid_version":
      return "That version isn't valid.";
    case undefined:
      return err instanceof Error && err.message
        ? `Couldn't reach the daemon: ${err.message}`
        : "Couldn't reach the daemon.";
    default:
      if ((VERIFICATION_REASONS as string[]).includes(code)) {
        return "Download failed verification. Nothing was changed.";
      }
      return err instanceof Error && err.message ? err.message : `Update failed (${code})`;
  }
}

/** `code` of a `restartDaemon` error outcome (an API error code, or `http_<status>`). */
type RestartErrorCode = Extract<RestartOutcome, { kind: "error" }>["code"];

export interface RestartErrorCopy {
  message: string;
  /** Restart can never succeed from here (hosted by Tauri / read-only token). */
  terminal: boolean;
}

/** Copy for a `restartDaemon` `{kind:"error"}` outcome. */
export function restartErrorCopy(code: RestartErrorCode): RestartErrorCopy {
  if (code === "tauri_hosted") {
    return { message: "Quit & relaunch vibe-station to finish.", terminal: true };
  }
  if (code === "mobile_read_only" || code === "http_403") {
    return { message: "Restart from your computer.", terminal: true };
  }
  return { message: `Couldn't restart (${code})`, terminal: false };
}

/**
 * Apply an error outcome from `restartDaemon`. `restart_in_progress` and
 * `update_in_progress` resolve to other UI states (overlay / progress) and
 * return null; everything else returns copy to render in a `role="alert"` box.
 */
export async function resolveRestartError(code: RestartErrorCode): Promise<RestartErrorCopy | null> {
  if (code === "restart_in_progress") {
    useUpdateStore.getState().setRestarting(true);
    return null;
  }
  if (code === "update_in_progress") {
    try {
      useUpdateStore.getState().setFromCheck(await fetchUpdateStatus(false));
    } catch {
      /* the WS snapshot will catch up */
    }
    return null;
  }
  return restartErrorCopy(code);
}

/** Retry (disabled until `retryAfter`) / View release / sudo command for an install failure. */
export function InstallRecoveryActions({
  status,
  error,
  canInstall,
  busy,
  onRetry,
  extra,
}: {
  status: UpdateStatus;
  error: UpdateError;
  canInstall: boolean;
  busy: boolean;
  onRetry: () => void;
  /** Rendered before the actions (e.g. the dialog's Close button). */
  extra?: React.ReactNode;
}) {
  const recovery = recoveryFor(error);
  const [wait, setWait] = useState(recovery.retryAfterMs);
  useEffect(() => {
    const ms = retryDelayMs(error.retryAfter);
    setWait(ms);
    if (ms <= 0) return;
    const id = setTimeout(() => setWait(0), ms);
    return () => clearTimeout(id);
  }, [error.retryAfter, error.reason]);

  const sudo = recovery.actions.includes("copy_sudo") ? sudoInstallCommand(status) : null;
  return (
    <>
      {sudo ? <ShellBlock command={sudo} /> : null}
      {extra}
      {canInstall && recovery.actions.includes("retry") ? (
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || wait > 0}
          onClick={onRetry}
        >
          {busy ? "Retrying…" : "Retry"}
        </button>
      ) : null}
      {recovery.actions.includes("view_release") && status.releaseUrl ? (
        <a
          href={status.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn--ghost"
        >
          View release
        </a>
      ) : null}
    </>
  );
}
