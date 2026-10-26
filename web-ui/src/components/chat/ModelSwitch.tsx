import { Fragment, useEffect, useRef, useState } from "react";
import { useEventTargets } from "@/context/DemoEnv";
import type { ApiInstance } from "@/api";
import type { CliId } from "@/api/types";
import { modelIconKey } from "@/lib/modelIcon";
import { ModeIcon } from "@/components/agent/ModeIcon";

/** One non-model row in the composer dropdown (Start fresh…, Switch…, Previous). */
export interface ModelAction {
  key: string;
  label: string;
  /** Right-aligned hint (e.g. the predecessor count). */
  hint?: string;
  /** Render a divider above this row (separates "Previous sessions"). */
  dividerBefore?: boolean;
  onSelect: () => void;
}

interface ModelSwitchProps {
  api: ApiInstance;
  sessionId: string;
  /** The session's CLI (from meta) — drives the model list. */
  cli: string;
  /** Currently-displayed model (from meta). */
  model: string | undefined;
  /** Mode name — the popover's title row. */
  title?: string;
  /** Extra rows below the models (the three session actions). */
  actions?: ModelAction[];
  /** Skip the model list entirely (cursor has no fetchable model list). */
  hideModels?: boolean;
  /** Icon key for the "(mode default)" row (the session's mode icon). */
  modeIconKey?: string | null;
}

/**
 * The composer's one dropdown (Decision B): today's live model list (each row
 * with its vendor icon), a divider, then the three session actions
 * (Start fresh… / Switch provider & mode… / Previous sessions).
 *
 * Model changes still apply to the next turn via PATCH …/chat/model;
 * optimistically shown until the next `session:meta` confirms it. A
 * "(mode default)" entry clears the per-session override.
 *
 * `role="menu"` with roving ArrowUp/ArrowDown across BOTH the model rows and
 * the action rows, so keyboard users reach the actions without tabbing.
 */
export function ModelSwitch({
  api,
  sessionId,
  cli,
  model,
  title,
  actions,
  hideModels,
  modeIconKey,
}: ModelSwitchProps) {
  const { doc } = useEventTargets();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // A fresh meta (model prop change) supersedes any optimistic guess.
  useEffect(() => {
    setOptimistic(null);
  }, [model]);

  // Fetch the model list on first open. NOTE: `loading` must NOT be in the deps —
  // setLoading(true) would re-run the effect and its cleanup would cancel the very
  // fetch it just started, so the list would never arrive.
  useEffect(() => {
    if (!open || hideModels || models.length > 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.listCliModels(cli as CliId).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.error) setError(r.error);
      else setModels(r.models);
    }).catch((e: unknown) => {
      if (cancelled) return;
      setLoading(false);
      setError(e instanceof Error ? e.message : "Could not fetch models");
    });
    return () => {
      cancelled = true;
    };
  }, [open, api, cli, models.length, hideModels]);

  // Move focus into the menu on open so ArrowUp/ArrowDown work right away
  // (the key handler lives on the popover, so focus must be inside it).
  // Rows can unmount/remount while the model list loads (which drops focus to
  // <body>), so whenever focus is not inside the menu, put it on the first row.
  useEffect(() => {
    if (!open) return;
    const first = rowRefs.current[0];
    if (!first || first.closest('[role="menu"]')?.contains(document.activeElement)) return;
    setFocusIdx(0);
    first.focus();
  }, [open, loading, models.length, error]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    doc.addEventListener("mousedown", onDown);
    return () => doc.removeEventListener("mousedown", onDown);
  }, [open, doc]);

  const shown = optimistic ?? model ?? "(default)";

  // Options: "(mode default)" (clears override) + the fetched models.
  const options: { label: string; value: string | null }[] = [
    { label: "(mode default)", value: null },
    ...models.filter((m) => m !== "default").map((m) => ({ label: m, value: m })),
  ];
  const modelRows = hideModels ? 0 : options.length;
  const actionRows = actions?.length ?? 0;
  const rowCount = modelRows + actionRows;

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

  function focusRow(i: number) {
    const clamped = Math.max(0, Math.min(i, rowCount - 1));
    setFocusIdx(clamped);
    rowRefs.current[clamped]?.focus();
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(focusIdx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(focusIdx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(rowCount - 1);
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
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Change model (current: ${shown})`}
        title="Change model"
        onClick={() => {
          setFocusIdx(0);
          setOpen((v) => !v);
        }}
      >
        <span className="chat-model-switch__label">{shown}</span>
        <span className="chat-model-switch__caret" aria-hidden> ▾</span>
      </button>
      {open ? (
        <div className="chat-model-switch__popover" role="menu" aria-label="Agent menu" onKeyDown={onMenuKeyDown}>
          {title ? <div className="chat-model-switch__title">{title}</div> : null}
          {!hideModels ? (
            <>
              <div className="chat-model-switch__note">Model · applies to the next turn</div>
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
                        rowRefs.current[i] = el;
                      }}
                      role="menuitemradio"
                      aria-checked={active}
                      tabIndex={i === focusIdx ? 0 : -1}
                      className={`chat-model-switch__option${active ? " chat-model-switch__option--active" : ""}`}
                      onClick={() => void pick(opt.value)}
                    >
                      <ModeIcon
                        iconKey={opt.value ? modelIconKey(opt.value) : (modeIconKey ?? null)}
                        size={13}
                      />
                      <span className="chat-model-switch__option-label">{opt.label}</span>
                    </button>
                  );
                })
              )}
            </>
          ) : null}
          {actions && actions.length > 0 ? (
            <>
              {!hideModels ? <div className="chat-model-switch__divider" aria-hidden /> : null}
              {actions.map((action, i) => {
                const rowIndex = modelRows + i;
                return (
                  <Fragment key={action.key}>
                    {action.dividerBefore && i > 0 ? (
                      <div className="chat-model-switch__divider" aria-hidden />
                    ) : null}
                    <button
                      type="button"
                      ref={(el) => {
                        rowRefs.current[rowIndex] = el;
                      }}
                      role="menuitem"
                      tabIndex={rowIndex === focusIdx ? 0 : -1}
                      className="chat-model-switch__option chat-model-switch__action"
                      onClick={() => {
                        setOpen(false);
                        action.onSelect();
                      }}
                    >
                      <span className="chat-model-switch__option-label">{action.label}</span>
                      {action.hint ? <span className="chat-model-switch__hint">{action.hint}</span> : null}
                    </button>
                  </Fragment>
                );
              })}
            </>
          ) : null}
        </div>
      ) : null}
      {error && !open ? <span className="chat-model-switch__error">{error}</span> : null}
    </div>
  );
}
