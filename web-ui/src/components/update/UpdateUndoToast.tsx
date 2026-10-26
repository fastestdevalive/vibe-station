import { useEffect } from "react";
import { unskipUpdate } from "@/api/update";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import { formatVersion } from "./updateView";

export interface UpdateUndoToastProps {
  version: string;
  onDismiss: () => void;
}

export function UpdateUndoToast({ version, onDismiss }: UpdateUndoToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      onDismiss();
    }, 5000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [onDismiss]);

  const handleUndo = async () => {
    try {
      const nextStatus = await unskipUpdate(version);
      useUpdateStore.getState().setStatus(nextStatus);
    } catch {
      // Best-effort
    } finally {
      onDismiss();
    }
  };

  return (
    <div className="update-undo-toast" role="status" aria-live="polite">
      <span>Skipped {formatVersion(version)}</span>
      <button
        type="button"
        className="update-undo-toast__btn"
        onClick={() => void handleUndo()}
      >
        Undo
      </button>
    </div>
  );
}
