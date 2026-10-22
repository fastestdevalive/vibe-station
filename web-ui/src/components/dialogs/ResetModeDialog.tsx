import { useEffect, useMemo, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode } from "@/api/types";
import { Dialog } from "./Dialog";

export interface ResetModeDialogProps {
  open: boolean;
  api: Pick<ApiInstance, "listModes">;
  /** Why the mode picker was shown (the daemon's error text or context). */
  reason?: string | null;
  /** Custom dialog title (defaults to "Choose a mode to reset with"). */
  title?: string;
  /** Custom confirm button label (defaults to "Reset with this mode"). */
  confirmLabel?: string;
  /** Custom prompt text (defaults to "Pick a mode for the fresh session."). */
  prompt?: string;
  /** Empty-state text shown once modes are loaded but none match the filter. */
  emptyMessage?: string;
  /** Pure filter to restrict selectable modes (e.g. only supportsJson CLIs). */
  filterMode?: (m: Mode) => boolean;
  onConfirm: (modeId: string) => void;
  onCancel: () => void;
}

/**
 * Shown when a reset or channel switch needs a mode because the session's own mode
 * is missing or deleted. Lets the user pick a valid mode and continue instead of dead-ending.
 */
export function ResetModeDialog({
  open,
  api,
  reason,
  title,
  confirmLabel,
  prompt,
  emptyMessage,
  filterMode,
  onConfirm,
  onCancel,
}: ResetModeDialogProps) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [selected, setSelected] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoaded(false);
    setLoadFailed(false);
    void api
      .listModes()
      .then((ms) => {
        if (cancelled) return;
        setLoadFailed(false);
        setModes(ms);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setModes([]);
          setLoadFailed(true);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  const displayModes = useMemo(
    () => (filterMode ? modes.filter(filterMode) : modes),
    [modes, filterMode],
  );

  useEffect(() => {
    if (!open) {
      setSelected("");
      return;
    }
    if (displayModes.length > 0) {
      setSelected((cur) => (displayModes.some((m) => m.id === cur) ? cur : (displayModes[0]?.id ?? "")));
    } else {
      setSelected("");
    }
  }, [open, displayModes]);

  const displayTitle = title ?? "Choose a mode to reset with";
  const displayConfirmLabel = confirmLabel ?? "Reset with this mode";
  const displayPrompt = prompt ?? "Pick a mode for the fresh session.";

  return (
    <Dialog
      open={open}
      title={displayTitle}
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" disabled={!selected} onClick={() => onConfirm(selected)}>
            {displayConfirmLabel}
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
        {reason && <>{reason}{"\n"}</>}
        {loadFailed
          ? "Couldn't load the mode list — close this and try again."
          : loaded && displayModes.length === 0
            ? (emptyMessage ?? "No modes — create one in Settings → Modes.")
            : displayPrompt}
      </p>
      {!loadFailed && displayModes.length > 0 && (
        <select
          aria-label="Mode"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          style={{ width: "100%" }}
        >
          {displayModes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.cli})
            </option>
          ))}
        </select>
      )}
    </Dialog>
  );
}
