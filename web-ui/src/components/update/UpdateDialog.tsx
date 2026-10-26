import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/dialogs/Dialog";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import type { UpdateStatus } from "@/api/types";
import { installUpdate, cancelUpdate, skipUpdate } from "@/api/update";
import { actionErrorCopy } from "./errorRecovery";
import { copyText } from "@/lib/copyText";
import { dialogState, dialogTitle } from "./updateView";
import { useDaemonRestart } from "./useDaemonRestart";
import type { DialogCtx, DialogView } from "./dialogContext";
import {
  availableView,
  installErrorView,
  installedDoneView,
  installingView,
  noAssetView,
} from "./UpdateDialogViews";
import { restartPendingView } from "./RestartPendingView";
import { manualUpdateView } from "./ManualUpdateView";

export function UpdateDialog() {
  const status = useUpdateStore((s) => s.status);
  const canInstall = useUpdateStore((s) => s.canInstall);
  const dialogOpen = useUpdateStore((s) => s.dialogOpen);
  const setDialogOpen = useUpdateStore((s) => s.setDialogOpen);
  const setRemindedFor = useUpdateStore((s) => s.setRemindedFor);

  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelledElsewhere, setCancelledElsewhere] = useState(false);
  const installSeen = useRef(false);
  const cancelledHere = useRef(false);

  const handleClose = useCallback(() => setDialogOpen(false), [setDialogOpen]);
  const restart = useDaemonRestart({ enabled: dialogOpen, onAccepted: handleClose });

  const handleCopyCommand = async (cmd: string) => {
    if (await copyText(cmd)) {
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 2000);
    }
  };

  // An install that vanished with no result/error while this tab did not
  // cancel it was cancelled from another client.
  const hasInstall = Boolean(status?.install);
  const noOutcome = !status?.lastResult && !status?.lastError && !status?.restartPending && !status?.rolledBack;
  useEffect(() => {
    if (hasInstall) {
      installSeen.current = true;
      setCancelledElsewhere(false);
    } else if (installSeen.current) {
      installSeen.current = false;
      if (!cancelledHere.current && noOutcome) setCancelledElsewhere(true);
      cancelledHere.current = false;
    }
  }, [hasInstall, noOutcome]);

  useEffect(() => {
    if (!dialogOpen) setCancelledElsewhere(false);
  }, [dialogOpen]);

  if (!dialogOpen || !status) return null;

  /** Run a request that replaces the status snapshot, surfacing its error copy. */
  const run = async (
    request: () => Promise<UpdateStatus>,
    after?: () => void,
  ) => {
    setBusy(true);
    setActionError(null);
    try {
      useUpdateStore.getState().setStatus(await request());
      after?.();
    } catch (err) {
      setActionError(actionErrorCopy(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    setActionError(null);
    cancelledHere.current = true;
    try {
      useUpdateStore.getState().setStatus(await cancelUpdate());
    } catch (err) {
      cancelledHere.current = false;
      setActionError(actionErrorCopy(err));
    } finally {
      setCancelling(false);
    }
  };

  const latest = status.latest ?? "";
  const ctx: DialogCtx = {
    status,
    canInstall,
    busy,
    cancelling,
    copiedCommand,
    cancelledElsewhere,
    restart,
    onClose: handleClose,
    onUpdateNow: () => void run(installUpdate),
    onCancel: () => void handleCancel(),
    onSkip: () => {
      if (!latest) return;
      void run(
        () => skipUpdate(latest),
        () => {
          useUpdateStore.getState().setUndoSkipVersion(latest);
          setDialogOpen(false);
        },
      );
    },
    onRemindLater: () => {
      if (latest) setRemindedFor(latest);
      setDialogOpen(false);
    },
    onCopyCommand: (cmd) => void handleCopyCommand(cmd),
  };

  const view: DialogView = (() => {
    switch (dialogState(status)) {
      case "no_asset":
        return noAssetView(ctx);
      case "installing":
        return installingView(ctx);
      case "restart_pending":
        return restartPendingView(ctx);
      case "manual":
        return manualUpdateView(ctx);
      case "done":
        return installedDoneView(ctx);
      case "error":
        return installErrorView(ctx);
      case "available":
        return availableView(ctx);
    }
  })();

  return (
    <Dialog
      open={dialogOpen}
      title={dialogTitle(status)}
      onClose={handleClose}
      footer={view.footer}
      cardClassName="update-dialog"
    >
      {view.body}
      {actionError ? (
        <div className="update-dialog__error-box" role="alert">
          {actionError}
        </div>
      ) : null}
    </Dialog>
  );
}
