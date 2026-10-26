import { useCallback } from "react";
import type { ApiInstance } from "@/api";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import { useUpdateSync } from "@/hooks/useUpdateSync";
import { RestartOverlay } from "./RestartOverlay";
import { UpdateDialog } from "./UpdateDialog";
import { UpdateStageAnnouncer } from "./UpdateStageAnnouncer";
import { UpdateUndoToast } from "./UpdateUndoToast";

/**
 * The app-global half of the update feature, mounted once in the workspace
 * route: status sync, the restart overlay, the details dialog, the Undo toast
 * and the stage live region. The TopBar chip is only a button that opens the
 * dialog, so a TopBar variant swap (or a second TopBar) never duplicates or
 * drops any of this.
 */
export function UpdateLayer({ api }: { api: ApiInstance }) {
  useUpdateSync(api);
  const toastVersion = useUpdateStore((s) => s.undoSkipVersion);
  const setToastVersion = useUpdateStore((s) => s.setUndoSkipVersion);
  // Stable so the toast's 5 s timer does not restart on re-renders.
  const dismissToast = useCallback(() => setToastVersion(null), [setToastVersion]);

  return (
    <>
      <UpdateStageAnnouncer />
      <RestartOverlay api={api} />
      <UpdateDialog />
      {toastVersion ? <UpdateUndoToast version={toastVersion} onDismiss={dismissToast} /> : null}
    </>
  );
}
