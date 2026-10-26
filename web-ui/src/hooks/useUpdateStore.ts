import { create } from "zustand";
import type { UpdateCheckResponse, UpdateStatus } from "@/api/types";

/**
 * Client copy of the daemon's `UpdateStatus` snapshot. The snapshot is always
 * REPLACED wholesale (never merged): the daemon is the only source of truth,
 * so a field that disappears from the snapshot must disappear here too.
 */
interface UpdateStoreState {
  status: UpdateStatus | null;
  /** false for Mobile-scope tokens. Only the HTTP check response carries it. */
  canInstall: boolean;
  /** Version the user chose "Remind me later" for (session-local). */
  remindedFor: string | null;
  dialogOpen: boolean;
  /** Version just skipped; drives the single Undo toast, shared by every skip entry point. */
  undoSkipVersion: string | null;
  restarting: boolean;
  /** `/health.bootId` recorded at page load: the restart overlay's
   *  baseline, so a daemon that is already gone (or already back) when the
   *  overlay mounts is still detected as a new boot. */
  loadBootId: string | null;
  /** Replace `status` + `canInstall` from a check response. */
  setFromCheck: (resp: UpdateCheckResponse) => void;
  /** Replace `status` only (WS events don't carry `canInstall`). */
  setStatus: (status: UpdateStatus) => void;
  setRemindedFor: (version: string | null) => void;
  setDialogOpen: (open: boolean) => void;
  setUndoSkipVersion: (version: string | null) => void;
  setRestarting: (restarting: boolean) => void;
  setLoadBootId: (bootId: string | null) => void;
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  status: null,
  canInstall: false,
  remindedFor: null,
  dialogOpen: false,
  undoSkipVersion: null,
  restarting: false,
  loadBootId: null,
  setFromCheck: (resp) => {
    // Strip `canInstall` so `status` is exactly the daemon's UpdateStatus.
    const { canInstall, ...status } = resp;
    set({ status, canInstall });
  },
  setStatus: (status) => set({ status }),
  setRemindedFor: (remindedFor) => set({ remindedFor }),
  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
  setUndoSkipVersion: (undoSkipVersion) => set({ undoSkipVersion }),
  setRestarting: (restarting) => set({ restarting }),
  setLoadBootId: (loadBootId) => set({ loadBootId }),
}));
