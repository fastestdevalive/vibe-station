import { useEffect, useId, useReducer, useMemo, useState } from "react";
import type { ApiInstance } from "@/api";
import type { CliId, SupportedCli } from "@/api/types";
import { Dialog } from "./Dialog";
import { Input } from "../ui/Input";
import { Radio } from "../ui/Radio";
import { ModeContextField } from "./ModeContextField";
import {
  CONTEXT_TOO_LONG_MESSAGE,
  contextFieldReducer,
  contextTooLong,
  initContextField,
  presetIdForSave,
} from "@/lib/modeContextPresets";
import { CliOptionLabel } from "../agent/CliOptionLabel";
import { ModelPicker } from "../shared/ModelPicker";
import { ModeIcon } from "../agent/ModeIcon";
import { deriveModeIcon } from "@/lib/modeIcon";

function modelPreference(cliId: string, apiDefault: string): string {
  try {
    const s = localStorage.getItem(`vst-last-model-${cliId}`);
    if (s) return s;
  } catch {
    /* ignore */
  }
  return apiDefault;
}

interface NewModeDialogProps {
  open: boolean;
  onClose: () => void;
  api: ApiInstance;
  existingNames?: string[];
  /** Harness to pre-select when the dialog opens (e.g. the active Settings tab). */
  initialCli?: string;
  onSaved?: () => void;
}

export function NewModeDialog({
  open,
  onClose,
  api,
  existingNames = [],
  initialCli,
  onSaved,
}: NewModeDialogProps) {
  const [clis, setClis] = useState<SupportedCli[]>([]);
  const [clisLoading, setClisLoading] = useState(true);
  const [name, setName] = useState("");
  const [cli, setCli] = useState<CliId>("");
  // The dialog owns the context field's state (Dialog's children unmount while
  // closed); Save sends exactly the text shown.
  const [contextState, dispatchContext] = useReducer(contextFieldReducer, undefined, initContextField);
  const context = contextState.text;
  const [model, setModel] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorId = useId();

  // Every open starts fresh (Cancel/Esc/× used to keep the half-typed name
  // and context for the next open, because this component stays mounted).
  useEffect(() => {
    if (!open) return;
    setName("");
    setError(null);
    dispatchContext({ type: "reset" });
  }, [open]);

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
              : (list.find((c) => c.id === initialCli) ??
                  list.find((c) => c.id === "claude") ??
                  list[0])?.id ?? "";
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

  // Re-apply the caller's preferred harness each time the dialog opens.
  useEffect(() => {
    if (!open || !initialCli) return;
    const match = clis.find((c) => c.id === initialCli);
    if (!match) return;
    setCli(match.id);
    setModel(modelPreference(match.id, match.defaultModel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialCli, clis]);

  const namesLower = useMemo(
    () => new Set(existingNames.map((n) => n.toLowerCase())),
    [existingNames],
  );

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
    if (namesLower.has(trimmed.toLowerCase())) {
      setError("A mode with this name already exists.");
      return;
    }
    if (!cli || clisLoading) {
      setError("CLIs are still loading.");
      return;
    }
    setSaving(true);
    try {
      await api.createMode({
        name: trimmed,
        cli,
        context,
        presetId: presetIdForSave(context),
        model: model && model.length > 0 ? model : undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      setSaving(false);
    }
    onSaved?.();
    onClose();
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
          name="cli"
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
      {cli ? (
        <div
          data-testid="new-mode-icon-preview"
          style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-3)", fontSize: "var(--font-size-sm)", color: "var(--fg-muted)" }}
        >
          Icon
          <ModeIcon iconKey={deriveModeIcon(cli, model)} channel="json" size={16} label={deriveModeIcon(cli, model) ?? undefined} />
        </div>
      ) : null}
      {error ? (
        <div id={errorId} className="field-error" role="alert">
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}
