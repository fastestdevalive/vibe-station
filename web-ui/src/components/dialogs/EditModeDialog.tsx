import { useEffect, useId, useReducer, useState } from "react";
import type { ApiInstance } from "@/api";
import type { CliId, Mode, SupportedCli } from "@/api/types";
import { Dialog } from "./Dialog";
import { Input } from "../ui/Input";
import { Radio } from "../ui/Radio";
import { CliOptionLabel } from "../agent/CliOptionLabel";
import { ModelPicker } from "../shared/ModelPicker";
import { ModeContextField } from "./ModeContextField";
import { CONTEXT_TOO_LONG_MESSAGE, contextFieldReducer, contextTooLong, initContextField } from "@/lib/modeContextPresets";

function modelPreference(cliId: string, apiDefault: string): string | undefined {
  try {
    const s = localStorage.getItem(`vst-last-model-${cliId}`);
    if (s) return s;
  } catch {
    /* ignore */
  }
  return apiDefault || undefined;
}

interface EditModeDialogProps {
  mode: Mode;
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
}

export function EditModeDialog({ mode, open, onClose, api }: EditModeDialogProps) {
  const [clis, setClis] = useState<SupportedCli[]>([]);
  const [clisLoading, setClisLoading] = useState(true);
  const [name, setName] = useState(mode.name);
  const [cli, setCli] = useState<CliId>(mode.cli);
  // The dialog owns the context field's state (Dialog's children unmount while
  // closed); Save sends exactly the text shown.
  const [contextState, dispatchContext] = useReducer(contextFieldReducer, mode.context, initContextField);
  const context = contextState.text;
  const [model, setModel] = useState<string | undefined>(mode.model);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorId = useId();

  useEffect(() => {
    let cancelled = false;
    setClisLoading(true);
    void api
      .getSupportedClis()
      .then((list) => {
        if (!cancelled) setClis(list);
      })
      .finally(() => {
        if (!cancelled) setClisLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Every open starts from the saved mode, like NewModeDialog.
  useEffect(() => {
    if (!open) return;
    setName(mode.name);
    setCli(mode.cli);
    dispatchContext({ type: "reset", savedText: mode.context });
    setModel(mode.model);
    setError(null);
  }, [open, mode]);

  async function submit() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    if (trimmed.length > 64) {
      setError("Name must be at most 64 characters.");
      return;
    }
    if (contextTooLong(context)) {
      setError(CONTEXT_TOO_LONG_MESSAGE);
      return;
    }
    if (clisLoading) {
      setError("CLIs are still loading.");
      return;
    }
    setSaving(true);
    try {
      await api.updateMode(mode.id, {
        name: trimmed,
        cli,
        context,
        model: model && model.length > 0 ? model : undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="Edit Agent Mode"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={clisLoading || saving} onClick={() => void submit()}>
            Save
          </button>
        </>
      }
    >
      <div className="field-label">Name</div>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-invalid={!!error}
        aria-label="Mode name"
      />
      <div className="field-label">CLI</div>
      {clisLoading ? (
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--fg-muted)",
            marginBottom: "var(--space-2)",
          }}
        >
          Loading CLIs…
        </div>
      ) : null}
      {clis.map((c) => (
        <Radio
          key={c.id}
          name="edit-cli"
          label={<CliOptionLabel cli={c.id} />}
          checked={cli === c.id}
          disabled={clisLoading}
          onChange={() => {
            setCli(c.id);
            setModel(modelPreference(c.id, c.defaultModel));
          }}
        />
      ))}
      <ModeContextField state={contextState} dispatch={dispatchContext} errorId={error ? errorId : undefined} />
      <div className="field-label">Model</div>
      <ModelPicker api={api} cli={cli || null} value={model} onChange={setModel} />
      {error ? (
        <div id={errorId} className="field-error" role="alert">
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}
