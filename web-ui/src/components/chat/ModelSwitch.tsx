import { useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { CliId } from "@/api/types";

interface ModelSwitchProps {
  api: ApiInstance;
  sessionId: string;
  /** The session's CLI (from meta) — drives the model list. */
  cli: string;
  /** Currently-displayed model (from meta). */
  model: string | undefined;
}

/**
 * Clickable status-bar model control. Opens a popover listing the CLI's models
 * (fetched lazily on first open) and switches the session's model live via
 * PATCH …/chat/model — the change applies to the next turn. Optimistically shows
 * the picked model until the next `session:meta` confirms it. A "(mode default)"
 * entry clears the per-session override.
 */
export function ModelSwitch({ api, sessionId, cli, model }: ModelSwitchProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // A fresh meta (model prop change) supersedes any optimistic guess.
  useEffect(() => {
    setOptimistic(null);
  }, [model]);

  // Fetch the model list on first open. NOTE: `loading` must NOT be in the deps —
  // setLoading(true) would re-run the effect and its cleanup would cancel the very
  // fetch it just started, so the list would never arrive.
  useEffect(() => {
    if (!open || models.length > 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.listCliModels(cli as CliId).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.error) setError(r.error);
      else setModels(r.models);
    });
    return () => {
      cancelled = true;
    };
  }, [open, api, cli, models.length]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const shown = optimistic ?? model ?? "(default)";

  // Options: "(mode default)" (clears override) + the fetched models.
  const options: { label: string; value: string | null }[] = [
    { label: "(mode default)", value: null },
    ...models.map((m) => ({ label: m, value: m })),
  ];

  async function pick(value: string | null) {
    setOpen(false);
    setOptimistic(value ?? "(default)");
    setError(null);
    try {
      await api.setSessionModel(sessionId, value);
    } catch (err) {
      setOptimistic(null);
      setError(err instanceof Error ? err.message : "Failed to switch model");
    }
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(focusIdx + 1, options.length - 1);
      setFocusIdx(next);
      itemRefs.current[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(focusIdx - 1, 0);
      setFocusIdx(next);
      itemRefs.current[next]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="chat-model-switch" ref={rootRef}>
      <button
        type="button"
        className="chat-statusbar__model chat-model-switch__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Change model (current: ${shown})`}
        title="Change model"
        onClick={() => {
          setFocusIdx(0);
          setOpen((v) => !v);
        }}
      >
        {shown}
        <span className="chat-model-switch__caret" aria-hidden> ▾</span>
      </button>
      {open ? (
        <div className="chat-model-switch__popover" role="listbox" aria-label="Model" onKeyDown={onListKeyDown}>
          {loading ? (
            <div className="chat-model-switch__note">Loading…</div>
          ) : error ? (
            <div className="chat-model-switch__note chat-model-switch__note--error">{error}</div>
          ) : (
            options.map((opt, i) => {
              const active = (opt.value ?? "(default)") === (model ?? "(default)");
              return (
                <button
                  key={opt.value ?? "__default__"}
                  type="button"
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  role="option"
                  aria-selected={active}
                  tabIndex={i === focusIdx ? 0 : -1}
                  className={`chat-model-switch__option${active ? " chat-model-switch__option--active" : ""}`}
                  onClick={() => void pick(opt.value)}
                >
                  {opt.label}
                </button>
              );
            })
          )}
        </div>
      ) : null}
      {error && !open ? <span className="chat-model-switch__error">{error}</span> : null}
    </div>
  );
}
