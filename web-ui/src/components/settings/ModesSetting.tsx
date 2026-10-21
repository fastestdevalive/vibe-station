import { useCallback, useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { Mode, SupportedCli } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { NewModeDialog } from "@/components/dialogs/NewModeDialog";
import { EditModeDialog } from "@/components/dialogs/EditModeDialog";
import { cliDisplayName } from "@/lib/cliNames";
import { SectionHeader } from "./SectionHeader";
import { HarnessTabs } from "./HarnessTabs";
import { HarnessPanel } from "./HarnessPanel";
import { ModeList } from "./ModeList";
import { readHarnessTab, writeHarnessTab } from "./harnessStorage";
import "./harness.css";

interface ModesSettingProps {
  api: ApiInstance;
}

export function ModesSetting({ api }: ModesSettingProps) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<Mode | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; msg: string } | null>(null);
  // Transient banner shown after deleting a mode that active sessions reference —
  // the mode's own row disappears immediately (mode:deleted removes it from
  // `modes`), so this can't be shown inline per-row.
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  const [clis, setClis] = useState<SupportedCli[]>([]);
  const [clisLoaded, setClisLoaded] = useState(false);
  const [tab, setTab] = useState<string | null>(() => readHarnessTab());

  const load = useCallback(async () => {
    const list = await api.listModes();
    setModes(list);
  }, [api]);

  const loadClis = useCallback(async () => {
    setClis(await api.getSupportedClis());
    setClisLoaded(true);
  }, [api]);

  useEffect(() => {
    void load();
    void loadClis();
  }, [load, loadClis]);

  // Selected harness: the remembered tab if it still exists, else the first
  // detected harness, else the first one.
  const selected =
    clis.find((c) => c.id === tab) ?? clis.find((c) => c.detected) ?? clis[0] ?? null;

  function selectTab(id: string) {
    setTab(id);
    writeHarnessTab(id);
  }

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
    // Clear any notice from a previous delete so a failed delete doesn't show
    // stale "mode deleted" text alongside the new error.
    setDeleteNotice(null);
    try {
      const result = await api.deleteMode(id);
      setPendingDeleteId(null);
      // Deleting an in-use mode is allowed — active sessions keep running with
      // their original settings; only a later resume/restart falls back to
      // defaults if the mode is gone by then. Let the user know when that
      // applies to them.
      if (result.affectedSessions > 0) {
        const plural = result.affectedSessions === 1 ? "session" : "sessions";
        setDeleteNotice(
          `Mode deleted. ${result.affectedSessions} active ${plural} using it will keep running as-is; if one of them restarts later, it'll fall back to default settings.`,
        );
      } else {
        setDeleteNotice(null);
      }
    } catch (e) {
      // Always reset pending state so the row shows Edit/Delete again (not a stuck "Delete?")
      setPendingDeleteId(null);
      const msg = e instanceof Error ? e.message : String(e);
      setDeleteError({ id, msg });
    }
  }

  const harnessModes = selected ? modes.filter((m) => m.cli === selected.id) : [];

  return (
    <div style={{ paddingBottom: "var(--space-8)" }}>
      <SectionHeader
        title="Harnesses and modes"
        description="A harness is an agent CLI. Modes define the harness, system prompt, and model used when starting a new agent session."
      />

      {!clisLoaded ? (
        <div className="settings-state">Loading harnesses…</div>
      ) : selected ? (
        <>
          <HarnessTabs clis={clis} selectedId={selected.id} onSelect={selectTab} />
          <HarnessPanel
            key={selected.id}
            api={api}
            cli={selected}
            hasAnyMode={modes.some((m) => m.cli === selected.id)}
            onChanged={async () => {
              await Promise.all([loadClis(), load()]);
            }}
          />

          <div className="harness-modes__head">
            <span className="harness-modes__title">{cliDisplayName(selected.id)} modes</span>
            <Button type="button" variant="solid" onClick={() => setNewOpen(true)}>
              + New mode
            </Button>
          </div>

          <div className="harness-notice">
            <Info size={14} style={{ marginTop: 2, flexShrink: 0, color: "var(--fg-muted)" }} />
            <span>
              Editing a mode only affects new sessions — running sessions continue with their original
              settings. Deleting a mode is allowed even if sessions are using it.
            </span>
          </div>
      {deleteNotice && (
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
          <span style={{ fontSize: "13px", color: "var(--fg-secondary)", lineHeight: 1.5, flex: 1 }}>
            {deleteNotice}
          </span>
          <button
            type="button"
            onClick={() => setDeleteNotice(null)}
            aria-label="Dismiss"
            style={{ background: "none", border: "none", color: "var(--fg-muted)", cursor: "pointer", padding: 0, font: "inherit" }}
          >
            Dismiss
          </button>
        </div>
      )}

          <ModeList
            modes={harnessModes}
            pendingDeleteId={pendingDeleteId}
            deleteError={deleteError}
            onEdit={setEditing}
            onAskDelete={(id) => {
              setDeleteError(null);
              setPendingDeleteId(id);
            }}
            onCancelDelete={() => setPendingDeleteId(null)}
            onConfirmDelete={(id) => void confirmDelete(id)}
          />
        </>
      ) : (
        <div className="settings-state">No harnesses are supported by this daemon.</div>
      )}

      <NewModeDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        api={api}
        existingNames={existingNames}
        initialCli={selected?.id}
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
