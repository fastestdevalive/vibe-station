import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode } from "@/api/types";
import { Dialog } from "./Dialog";

interface ResetModeDialogProps {
  open: boolean;
  api: Pick<ApiInstance, "listModes">;
  /** Why the reset couldn't proceed (the daemon's error text). */
  reason: string;
  onConfirm: (modeId: string) => void;
  onCancel: () => void;
}

/**
 * Shown when a reset is rejected because the session's own mode is gone (or it
 * never had one). Lets the user pick a replacement mode and retry the reset
 * with it, instead of dead-ending on an error.
 */
export function ResetModeDialog({ open, api, reason, onConfirm, onCancel }: ResetModeDialogProps) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [selected, setSelected] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    void api
      .listModes()
      .then((ms) => {
        if (cancelled) return;
        setLoadFailed(false);
        setModes(ms);
        setSelected((cur) => (ms.some((m) => m.id === cur) ? cur : (ms[0]?.id ?? "")));
      })
      .catch(() => {
        if (!cancelled) {
          setModes([]);
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  return (
    <Dialog
      open={open}
      title="Choose a mode to reset with"
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" disabled={!selected} onClick={() => onConfirm(selected)}>
            Reset with this mode
          </button>
        </>
      }
    >
      <p
        style={{
          margin: "0 0 var(--space-3, 12px)",
          fontSize: "var(--font-size-sm)",
          color: "var(--fg-secondary)",
          whiteSpace: "pre-line",
        }}
      >
        {reason}
        {"\n"}
        {loadFailed ? "Couldn't load the mode list — close this and try again." : "Pick a mode for the fresh session."}
      </p>
      <select
        aria-label="Mode"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        style={{ width: "100%" }}
      >
        {modes.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.cli})
          </option>
        ))}
      </select>
    </Dialog>
  );
}
