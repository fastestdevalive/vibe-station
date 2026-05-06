import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { CliId, Mode, SupportedCli } from "@/api/types";
import { Dialog } from "./Dialog";
import { Input } from "../ui/Input";
import { Radio } from "../ui/Radio";
import { ModelPicker } from "../shared/ModelPicker";

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
  const [context, setContext] = useState(mode.context);
  const [model, setModel] = useState<string | undefined>(mode.model);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    setName(mode.name);
    setCli(mode.cli);
    setContext(mode.context);
    setModel(mode.model);
    setError(null);
  }, [mode]);

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
    if (context.length > 10 * 1024) {
      setError("Context must be at most 10KB.");
      return;
    }
    if (clisLoading) {
      setError("CLIs are still loading.");
      return;
    }
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
          <button type="button" disabled={clisLoading} onClick={() => void submit()}>
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
          label={c.id}
          checked={cli === c.id}
          disabled={clisLoading}
          onChange={() => {
            setCli(c.id);
            setModel(modelPreference(c.id, c.defaultModel));
          }}
        />
      ))}
      <div className="field-label">Context</div>
      <textarea
        aria-label="Mode context"
        value={context}
        onChange={(e) => setContext(e.target.value)}
        rows={6}
        style={{
          width: "100%",
          padding: "var(--space-2) var(--space-3)",
          borderRadius: "var(--radius-sm)",
          border: "var(--border-width) solid var(--border-default)",
          background: "var(--bg-input)",
          color: "var(--fg-primary)",
          fontFamily: "inherit",
        }}
      />
      <div className="field-label">Model</div>
      <ModelPicker api={api} cli={cli || null} value={model} onChange={setModel} />
      {error ? <div className="field-error">{error}</div> : null}
    </Dialog>
  );
}
