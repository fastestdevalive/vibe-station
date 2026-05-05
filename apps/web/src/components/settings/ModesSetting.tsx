import { useCallback, useEffect, useMemo, useState } from "react";
import { Info, Pencil, Trash2 } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { Mode } from "@/api/types";
import { ApiError } from "@/api/errors";
import { Button } from "@/components/ui/Button";
import { NewModeDialog } from "@/components/dialogs/NewModeDialog";
import { EditModeDialog } from "@/components/dialogs/EditModeDialog";
import { SectionHeader } from "./SectionHeader";

interface ModesSettingProps {
  api: ApiInstance;
}

export function ModesSetting({ api }: ModesSettingProps) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<Mode | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; msg: string } | null>(null);

  const load = useCallback(async () => {
    const list = await api.listModes();
    setModes(list);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const off1 = api.on("mode:created", (ev) => {
      if (ev.type !== "mode:created") return;
      setModes((ms) => [...ms, ev.mode]);
    });
    const off2 = api.on("mode:updated", (ev) => {
      if (ev.type !== "mode:updated") return;
      setModes((ms) => ms.map((m) => (m.id === ev.mode.id ? ev.mode : m)));
    });
    const off3 = api.on("mode:deleted", (ev) => {
      if (ev.type !== "mode:deleted") return;
      setModes((ms) => ms.filter((m) => m.id !== ev.modeId));
    });
    return () => {
      off1();
      off2();
      off3();
    };
  }, [api]);

  const existingNames = useMemo(() => modes.map((m) => m.name), [modes]);

  async function confirmDelete(id: string) {
    setDeleteError(null);
    try {
      await api.deleteMode(id);
      setPendingDeleteId(null);
    } catch (e) {
      // Always reset pending state so the row shows Edit/Delete again (not a stuck "Delete?")
      setPendingDeleteId(null);
      const msg = e instanceof ApiError && e.status === 409
        ? "This mode is being used by an active session. Stop the session first."
        : (e instanceof Error ? e.message : String(e));
      setDeleteError({ id, msg });
    }
  }

  return (
    <div style={{ paddingBottom: "var(--space-8)" }}>
      <SectionHeader
        title="Modes"
        description="Orchestrator modes define the CLI, system prompt, and model used when starting a new agent session."
      />

      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          padding: "var(--space-3)",
          borderRadius: "var(--radius-sm)",
          border: "var(--border-width) solid var(--border-default)",
          background: "var(--bg-input)",
          marginBottom: "var(--space-5)",
          alignItems: "flex-start",
        }}
      >
        <Info size={14} style={{ marginTop: 2, flexShrink: 0, color: "var(--fg-muted)" }} />
        <span style={{ fontSize: "13px", color: "var(--fg-secondary)", lineHeight: 1.5 }}>
          Editing a mode only affects new sessions — running sessions continue with their original
          settings.
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        {modes.length === 0 && (
          <div style={{ padding: "var(--space-5) 0", textAlign: "center", color: "var(--fg-muted)", fontSize: "var(--font-size-sm)" }}>
            No modes yet. Create one to get started.
          </div>
        )}
        {modes.map((m) => (
          <div
            key={m.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              padding: "var(--space-3)",
              borderRadius: "var(--radius-sm)",
              border: "var(--border-width) solid var(--border-default)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, color: "var(--fg-primary)" }}>{m.name}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: 4 }}>
                <span
                  style={{
                    fontSize: "11px",
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: "var(--bg-input)",
                    color: "var(--fg-muted)",
                    border: "var(--border-width) solid var(--border-default)",
                  }}
                >
                  {m.cli}
                </span>
                {m.model ? (
                  <span
                    style={{
                      fontSize: "11px",
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "var(--bg-input)",
                      color: "var(--fg-secondary)",
                      border: "var(--border-width) solid var(--border-default)",
                    }}
                  >
                    {m.model}
                  </span>
                ) : null}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              {pendingDeleteId === m.id ? (
                <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "13px" }}>
                  Delete?
                  <button type="button" onClick={() => void confirmDelete(m.id)}
                    style={{ background: "none", border: "none", color: "var(--fg-primary)", cursor: "pointer", textDecoration: "underline", padding: 0, font: "inherit" }}>
                    Yes
                  </button>
                  <button type="button" onClick={() => setPendingDeleteId(null)}
                    style={{ background: "none", border: "none", color: "var(--fg-muted)", cursor: "pointer", padding: 0, font: "inherit" }}>
                    No
                  </button>
                </span>
              ) : (
                <div style={{ display: "flex", gap: 4 }}>
                  <Button type="button" variant="ghost" aria-label={`Edit ${m.name}`} onClick={() => setEditing(m)}>
                    <Pencil size={16} />
                  </Button>
                  <Button type="button" variant="ghost" aria-label={`Delete ${m.name}`}
                    onClick={() => { setDeleteError(null); setPendingDeleteId(m.id); }}>
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

      <div style={{ marginTop: "var(--space-5)" }}>
        <Button type="button" variant="solid" onClick={() => setNewOpen(true)}>
          + New mode
        </Button>
      </div>

      <NewModeDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        api={api}
        existingNames={existingNames}
        onSaved={() => void load()}
      />

      {editing ? (
        <EditModeDialog
          mode={editing}
          open
          onClose={() => setEditing(null)}
          api={api}
        />
      ) : null}
    </div>
  );
}
