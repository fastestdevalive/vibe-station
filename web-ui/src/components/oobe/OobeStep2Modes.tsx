import { useCallback, useEffect, useState } from "react";
import { Info, Pencil, Trash2 } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { Mode, SupportedCli } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { ModeIcon } from "@/components/agent/ModeIcon";
import { CliDetectionPanel } from "@/components/agent/CliDetectionPanel";
import { EditModeDialog } from "@/components/dialogs/EditModeDialog";
import { NewModeDialog } from "@/components/dialogs/NewModeDialog";

interface OobeStep2ModesProps {
  api: ApiInstance;
  onStep2Confirmed: () => void;
}

export function OobeStep2Modes({ api, onStep2Confirmed }: OobeStep2ModesProps) {
  const [supportedClis, setSupportedClis] = useState<SupportedCli[]>([]);
  const [modes, setModes] = useState<Mode[]>([]);
  const [editing, setEditing] = useState<Mode | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; msg: string } | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [finishBusy, setFinishBusy] = useState(false);
  const [detectBusy, setDetectBusy] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  // Bumped after every successful detectAndBundleOobe() call, and threaded
  // into CliDetectionPanel's refreshSignal prop — without this, the panel's
  // own independent getSupportedClis() fetch races this component's own
  // detect-and-bundle call instead of reading its result, so the detected/
  // fallback badges can read stale.
  const [refreshSignal, setRefreshSignal] = useState(0);

  const refresh = useCallback(async () => {
    setDetectError(null);
    try {
      const [res, list] = await Promise.all([api.detectAndBundleOobe(), api.listModes()]);
      setSupportedClis(res.supportedClis);
      setModes(list);
      setRefreshSignal((n) => n + 1);
    } catch (e) {
      // Without this, a failed fetch leaves `supportedClis` at its initial
      // `[]` forever — `zeroDetected` requires `length > 0` so it never
      // shows either, meaning NEITHER the normal mode list NOR the zero-CLI
      // Re-check affordance renders: Finish stays disabled with no way
      // forward and no explanation. Surface it and offer a retry instead.
      setDetectError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const offCreated = api.on("mode:created", () => {
      void api.listModes().then(setModes);
    });
    const offUpdated = api.on("mode:updated", () => {
      void api.listModes().then(setModes);
    });
    const offDeleted = api.on("mode:deleted", () => {
      void api.listModes().then(setModes);
    });
    return () => {
      offCreated();
      offUpdated();
      offDeleted();
    };
  }, [api]);

  const detectedIds = new Set(supportedClis.filter((c) => c.detected).map((c) => c.id));
  const detectedModes = modes.filter((m) => detectedIds.has(m.cli));

  const canFinish = modes.some(
    (m) => supportedClis.find((c) => c.id === m.cli)?.detected === true,
  );

  const zeroDetected = supportedClis.length > 0 && !supportedClis.some((c) => c.detected);

  async function handleFinish() {
    setFinishError(null);
    setFinishBusy(true);
    try {
      await api.confirmOobeStep2();
      onStep2Confirmed();
    } catch (e) {
      setFinishError(e instanceof Error ? e.message : String(e));
    } finally {
      setFinishBusy(false);
    }
  }

  async function handleRecheck() {
    setDetectBusy(true);
    try {
      await refresh();
    } finally {
      setDetectBusy(false);
    }
  }

  async function confirmDelete(id: string) {
    setDeleteError(null);
    try {
      await api.deleteMode(id);
      setPendingDeleteId(null);
    } catch (e) {
      setPendingDeleteId(null);
      setDeleteError({ id, msg: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div data-testid="oobe-step2" style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <div>
        <div style={{ fontSize: "var(--font-size-lg)", fontWeight: "var(--font-weight-semibold)", color: "var(--fg-primary)" }}>
          Set up your first agent mode
        </div>
        <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--font-size-sm)", color: "var(--fg-muted)", lineHeight: 1.5 }}>
          We&apos;ll detect installed CLIs and get a starter mode ready for you.
        </p>
        <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", lineHeight: 1.5 }}>
          A mode pairs a CLI, a model, and a system prompt — it&apos;s the config a spawned agent runs with.
        </p>
      </div>

      <CliDetectionPanel api={api} variant="oobe" refreshSignal={refreshSignal} />

      {detectError && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            padding: "var(--space-3)",
            borderRadius: "var(--radius-sm)",
            border: "var(--border-width) solid var(--fg-danger)",
            background: "var(--bg-input)",
          }}
        >
          <Info size={14} style={{ flexShrink: 0, color: "var(--fg-danger)" }} />
          <span style={{ flex: 1, fontSize: "13px", color: "var(--fg-secondary)", lineHeight: 1.5 }}>
            Couldn&apos;t check installed CLIs ({detectError}).
          </span>
          <button type="button" onClick={() => void handleRecheck()} disabled={detectBusy} className="btn btn--secondary">
            Retry
          </button>
        </div>
      )}

      {zeroDetected && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            padding: "var(--space-3)",
            borderRadius: "var(--radius-sm)",
            border: "var(--border-width) solid var(--border-default)",
            background: "var(--bg-input)",
          }}
        >
          <Info size={14} style={{ flexShrink: 0, color: "var(--fg-muted)" }} />
          <span style={{ flex: 1, fontSize: "13px", color: "var(--fg-secondary)", lineHeight: 1.5 }}>
            At least one agent CLI (e.g. claude) must be installed before you can continue. Install one,
            then re-check.
          </span>
          <button type="button" onClick={() => void handleRecheck()} disabled={detectBusy} className="btn btn--secondary">
            Re-check
          </button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        {detectedModes.length === 0 && !zeroDetected && (
          <div style={{ padding: "var(--space-5) 0", textAlign: "center", color: "var(--fg-muted)", fontSize: "var(--font-size-sm)" }}>
            No modes for your detected CLIs yet. Create one to get started.
          </div>
        )}
        {detectedModes.map((m) => (
          <div
            key={m.id}
            data-testid={`mode-row-${m.id}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              padding: "var(--space-3)",
              borderRadius: "var(--radius-sm)",
              border: "var(--border-width) solid var(--border-default)",
            }}
          >
            <span aria-hidden="true" style={{ display: "inline-flex" }}>
              <ModeIcon iconKey={m.icon} channel="json" size={20} />
            </span>
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

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button type="button" variant="solid" onClick={() => setNewOpen(true)}>
          + Add another mode
        </Button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        {finishError ? (
          <div className="field-error" data-testid="oobe-finish-error">
            {finishError}
          </div>
        ) : null}
        <button
          type="button"
          data-testid="oobe-finish"
          disabled={!canFinish || finishBusy}
          onClick={() => void handleFinish()}
          className="btn btn--primary"
        >
          Next
        </button>
      </div>

      <NewModeDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        api={api}
        existingNames={modes.map((m) => m.name)}
        onSaved={() => void api.listModes().then(setModes)}
      />

      {editing ? (
        <EditModeDialog mode={editing} open onClose={() => setEditing(null)} api={api} />
      ) : null}
    </div>
  );
}
