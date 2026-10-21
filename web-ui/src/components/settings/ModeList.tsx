import { Pencil, Trash2 } from "lucide-react";
import type { Mode } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { ModeIcon } from "@/components/agent/ModeIcon";
import { cliDisplayName } from "@/lib/cliNames";
import "./harness.css";

const chip = {
  fontSize: "11px",
  padding: "2px 6px",
  borderRadius: 4,
  background: "var(--bg-input)",
  border: "var(--border-width) solid var(--border-default)",
} as const;

interface ModeListProps {
  modes: Mode[];
  pendingDeleteId: string | null;
  deleteError: { id: string; msg: string } | null;
  onEdit: (m: Mode) => void;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
}

/** The mode rows for one harness, with edit / delete(+confirm) actions. */
export function ModeList({
  modes,
  pendingDeleteId,
  deleteError,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: ModeListProps) {
  if (modes.length === 0) {
    return (
      <div className="settings-state" style={{ textAlign: "center" }}>
        No modes for this harness yet. Create one to get started.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {modes.map((m) => (
        <div key={m.id} className="harness-mode">
          <span aria-hidden="true" style={{ display: "inline-flex" }}>
            <ModeIcon iconKey={m.icon} channel="json" size={20} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, color: "var(--fg-primary)", overflowWrap: "anywhere" }}>{m.name}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: 4 }}>
              <span style={{ ...chip, color: "var(--fg-muted)" }}>{cliDisplayName(m.cli)}</span>
              {m.model ? <span style={{ ...chip, color: "var(--fg-secondary)" }}>{m.model}</span> : null}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            {pendingDeleteId === m.id ? (
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "13px" }}>
                Delete?
                <button type="button" onClick={() => onConfirmDelete(m.id)}
                  style={{ background: "none", border: "none", color: "var(--fg-primary)", cursor: "pointer", textDecoration: "underline", padding: 0, font: "inherit" }}>
                  Yes
                </button>
                <button type="button" onClick={onCancelDelete}
                  style={{ background: "none", border: "none", color: "var(--fg-muted)", cursor: "pointer", padding: 0, font: "inherit" }}>
                  No
                </button>
              </span>
            ) : (
              <div style={{ display: "flex", gap: 4 }}>
                <Button type="button" variant="ghost" aria-label={`Edit ${m.name}`} onClick={() => onEdit(m)}>
                  <Pencil size={16} />
                </Button>
                <Button type="button" variant="ghost" aria-label={`Delete ${m.name}`} onClick={() => onAskDelete(m.id)}>
                  <Trash2 size={16} />
                </Button>
              </div>
            )}
            {deleteError?.id === m.id && (
              <div className="field-error" style={{ fontSize: "var(--font-size-xs)", textAlign: "right" }}>
                {deleteError.msg}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
