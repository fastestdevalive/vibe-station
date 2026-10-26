import { useCallback, useEffect, useState } from "react";
import { restartDaemon } from "@/api/update";
import type { ImpactItem } from "@/api/types";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import { actionErrorCopy, resolveRestartError, type RestartErrorCopy } from "./errorRecovery";

export interface UseDaemonRestartOptions {
  /** False while the surface showing the restart UI is closed (the dialog); no dry-run is made then. */
  enabled?: boolean;
  /** Called once the daemon accepted the restart (the dialog closes itself here). */
  onAccepted?: () => void;
}

export interface DaemonRestart {
  /** Sessions the restart would interrupt, from the dry run or a 409 "busy" reply. */
  impact: ImpactItem[] | null;
  /** A busy daemon asked for confirmation; the next `restart(true)` is "Restart anyway". */
  confirming: boolean;
  busy: boolean;
  error: RestartErrorCopy | null;
  restart: (confirm?: boolean) => Promise<void>;
  /** Leave the "Restart anyway" confirmation without restarting. */
  cancelConfirm: () => void;
}

/**
 * The daemon-restart flow shared by the update dialog and Settings > Updates:
 * a best-effort dry run for the impact list while a daemon restart is pending,
 * then the real restart with busy confirmation and per-reason error copy.
 * An accepted restart raises the global restart overlay.
 */
export function useDaemonRestart({ enabled = true, onAccepted }: UseDaemonRestartOptions = {}): DaemonRestart {
  const canInstall = useUpdateStore((s) => s.canInstall);
  const daemonRestartPending = useUpdateStore((s) => s.status?.restartPending?.kind === "daemon");
  const [impact, setImpact] = useState<ImpactItem[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RestartErrorCopy | null>(null);

  const active = enabled && canInstall && daemonRestartPending;

  useEffect(() => {
    if (!active) {
      setImpact(null);
      setConfirming(false);
      setError(null);
      return;
    }
    let cancelled = false;
    restartDaemon({ dryRun: true })
      .then((outcome) => {
        if (!cancelled && (outcome.kind === "impact" || outcome.kind === "busy")) {
          setImpact(outcome.impact);
        }
      })
      .catch(() => {
        /* the impact preview is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const restart = useCallback(
    async (confirm = false) => {
      setBusy(true);
      setError(null);
      try {
        const outcome = await restartDaemon({ confirm });
        if (outcome.kind === "accepted") {
          useUpdateStore.getState().setRestarting(true);
          onAccepted?.();
        } else if (outcome.kind === "busy") {
          setImpact(outcome.impact);
          setConfirming(true);
        } else if (outcome.kind === "error") {
          setError(await resolveRestartError(outcome.code));
        }
      } catch (err) {
        setError({ message: actionErrorCopy(err), terminal: false });
      } finally {
        setBusy(false);
      }
    },
    [onAccepted],
  );

  const cancelConfirm = useCallback(() => setConfirming(false), []);

  return { impact, confirming, busy, error, restart, cancelConfirm };
}
