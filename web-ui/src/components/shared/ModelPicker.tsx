import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { CliId } from "@/api/types";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

export interface ModelPickerProps {
  api: ApiInstance;
  cli: CliId | null;
  value: string | undefined;
  onChange: (model: string | undefined) => void;
}

export function ModelPicker({ api, cli, value, onChange }: ModelPickerProps) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!cli) {
      setModels([]);
      setFetchError(null);
      setLoading(false);
      return;
    }
    // Clear stale list immediately so old CLI's models don't flash during switch
    setModels([]);
    setFetchError(null);
    let cancelled = false;
    setLoading(true);
    void api.listCliModels(cli).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.error) {
        setFetchError(r.error);
        setModels([]);
      } else {
        setModels(r.models);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, cli]);

  function persistAndNotify(nextRaw: string) {
    if (!cli) return;
    const trimmed = nextRaw.trim();
    try {
      if (trimmed) localStorage.setItem(`vst-last-model-${cli}`, trimmed);
    } catch { /* ignore */ }
    onChange(trimmed ? trimmed : undefined);
  }

  if (!cli) {
    return (
      <Select disabled aria-label="Model">
        <option value="">(default)</option>
      </Select>
    );
  }

  if (fetchError) {
    return (
      <div>
        <span
          style={{
            display: "block",
            fontSize: "13px",
            color: "var(--fg-muted)",
            marginBottom: "var(--space-2)",
          }}
        >
          Could not fetch models. Type a model name below.
        </span>
        <Input
          aria-label="Model name"
          value={value ?? ""}
          onChange={(e) => persistAndNotify(e.target.value)}
          placeholder="Model id"
        />
      </div>
    );
  }

  const selectValue = value ?? "";
  // If the saved value isn't in the fetched list, include it as an option so
  // the select doesn't silently fall back to "(default)" while state still
  // holds the old value — makes the mismatch visible to the user.
  const valueInList = !selectValue || models.includes(selectValue);

  return (
    <Select
      disabled={loading}
      aria-label="Model"
      value={selectValue}
      onChange={(e) => persistAndNotify(e.target.value)}
    >
      <option value="">(default)</option>
      {!valueInList && (
        <option value={selectValue}>{selectValue} (not in current list)</option>
      )}
      {models.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </Select>
  );
}
