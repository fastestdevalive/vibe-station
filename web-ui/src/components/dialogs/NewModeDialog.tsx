import { useEffect, useMemo, useState } from "react";
import type { ApiInstance } from "@/api";
import type { CliId, SupportedCli } from "@/api/types";
import { Dialog } from "./Dialog";
import { Input } from "../ui/Input";
import { Radio } from "../ui/Radio";
import { ModelPicker } from "../shared/ModelPicker";

function modelPreference(cliId: string, apiDefault: string): string {
  try {
    const s = localStorage.getItem(`vst-last-model-${cliId}`);
    if (s) return s;
  } catch {
    /* ignore */
  }
  return apiDefault;
}

const PRESET_BUG =
  "You are fixing a bug. Open a PR when done. Run tests before committing.";
const PRESET_PLAN =
  "You are planning. Do not commit or open a PR. Output a written plan.";

export type PresetId = "bug-fix-with-pr" | "planning-no-pr" | "custom";

interface NewModeDialogProps {
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
  existingNames?: string[];
  onSaved?: () => void;
}

export function NewModeDialog({
  open,
  onClose,
  api,
  existingNames = [],
  onSaved,
}: NewModeDialogProps) {
  const [clis, setClis] = useState<SupportedCli[]>([]);
  const [clisLoading, setClisLoading] = useState(true);
  const [name, setName] = useState("");
  const [cli, setCli] = useState<CliId>("");
  const [preset, setPreset] = useState<PresetId>("bug-fix-with-pr");
  const [context, setContext] = useState(PRESET_BUG);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setClisLoading(true);
    void api
      .getSupportedClis()
      .then((list) => {
        if (cancelled) return;
        setClis(list);
        setCli((prev) => {
          const nextId =
            list.some((c) => c.id === prev)
              ? prev
              : (list.find((c) => c.id === "claude") ?? list[0])?.id ?? "";
          const def = list.find((c) => c.id === nextId)?.defaultModel ?? "";
          setModel(modelPreference(nextId, def));
          return nextId;
        });
      })
      .finally(() => {
        if (!cancelled) setClisLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const namesLower = useMemo(
    () => new Set(existingNames.map((n) => n.toLowerCase())),
    [existingNames],
  );

  function applyPreset(p: PresetId) {
    setPreset(p);
    if (p === "bug-fix-with-pr") setContext(PRESET_BUG);
    else if (p === "planning-no-pr") setContext(PRESET_PLAN);
    else setContext("");
  }

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
    if (namesLower.has(trimmed.toLowerCase())) {
      setError("A mode with this name already exists.");
      return;
    }
    if (!cli || clisLoading) {
      setError("CLIs are still loading.");
      return;
    }
    await api.createMode({
      name: trimmed,
      cli,
      context,
      presetId: preset === "custom" ? undefined : preset,
      model: model && model.length > 0 ? model : undefined,
    });
    onSaved?.();
    onClose();
    setName("");
    applyPreset("bug-fix-with-pr");
    const def = clis.find((c) => c.id === cli)?.defaultModel ?? "";
    setModel(modelPreference(cli, def));
  }

  return (
    <Dialog
      open={open}
      title="New Agent Mode"
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
          name="cli"
          label={c.id}
          checked={cli === c.id}
          disabled={clisLoading}
          onChange={() => {
            setCli(c.id);
            setModel(modelPreference(c.id, c.defaultModel));
          }}
        />
      ))}
      <div className="field-label">Context preset</div>
      <Radio
        name="preset"
        label="Bug fix with PR"
        checked={preset === "bug-fix-with-pr"}
        onChange={() => applyPreset("bug-fix-with-pr")}
      />
      <Radio
        name="preset"
        label="Planning without PR"
        checked={preset === "planning-no-pr"}
        onChange={() => applyPreset("planning-no-pr")}
      />
      <Radio
        name="preset"
        label="Custom"
        checked={preset === "custom"}
        onChange={() => applyPreset("custom")}
      />
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
