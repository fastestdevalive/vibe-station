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
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    void api.listCliModels(cli).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.error) {
        setFetchError(r.error);
        setModels([]);
      } else {
        setModels(r.models);
        setFetchError(null);
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
      if (trimmed) {
        localStorage.setItem(`vst-last-model-${cli}`, trimmed);
      }
    } catch {
      /* ignore */
    }
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

  const selectValue = value === undefined || value === "" ? "" : value;

  return (
    <Select
      disabled={loading}
      aria-label="Model"
      value={selectValue}
      onChange={(e) => {
        const v = e.target.value;
        persistAndNotify(v);
      }}
    >
      <option value="">(default)</option>
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </Select>
  );
}
