import type { ReactNode } from "react";
import type { UpdateStatus } from "@/api/types";
import type { DaemonRestart } from "./useDaemonRestart";

/** What the dialog hands to each state view: the snapshot, flags and actions. */
export interface DialogCtx {
  status: UpdateStatus;
  canInstall: boolean;
  /** An install/skip request is in flight. */
  busy: boolean;
  cancelling: boolean;
  copiedCommand: boolean;
  /** The install this tab was watching vanished without a result: another client cancelled it. */
  cancelledElsewhere: boolean;
  restart: DaemonRestart;
  onClose: () => void;
  onUpdateNow: () => void;
  onCancel: () => void;
  onSkip: () => void;
  onRemindLater: () => void;
  onCopyCommand: (cmd: string) => void;
}

/** One dialog state: its body, and the footer buttons. */
export interface DialogView {
  body: ReactNode;
  footer: ReactNode;
}
