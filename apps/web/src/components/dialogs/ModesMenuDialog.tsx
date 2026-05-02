import { useCallback, useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode } from "@/api/types";
import { Dialog } from "./Dialog";

interface ModesMenuDialogProps {
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
  onNewMode?: () => void;
}

export function ModesMenuDialog({ open, onClose, api, onNewMode }: ModesMenuDialogProps) {
  const [modes, setModes] = useState<Mode[]>([]);

  const refresh = useCallback(async () => {
    setModes(await api.listModes());
  }, [api]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  return (
    <Dialog
      open={open}
      title="Modes"
      onClose={onClose}
      footer={
        <button type="button" onClick={() => onNewMode?.()}>
          + New mode
        </button>
      }
    >
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {modes.slice(0, 10).map((m) => (
          <li
            key={m.id}
            style={{
              padding: "var(--space-2) 0",
              borderBottom: "1px solid var(--border-subtle)",
              display: "flex",
              justifyContent: "space-between",
              gap: "var(--space-2)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            <span>{m.name}</span>
            <span style={{ color: "var(--fg-muted)" }}>{m.cli}</span>
          </li>
        ))}
      </ul>
      {modes.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: "var(--font-size-sm)" }}>No modes yet.</p>
      ) : null}
    </Dialog>
  );
}
