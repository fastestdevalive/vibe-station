import { useEffect, useId, useRef, useState, type CSSProperties, type Dispatch } from "react";
import { Radio } from "../ui/Radio";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  MODE_CONTEXT_PRESETS,
  canRestoreStash,
  normalizeContext,
  presetById,
  selectionForText,
  selectionLabel,
  selectionOf,
  type ContextFieldAction,
  type ContextFieldState,
  type ContextSelection,
} from "@/lib/modeContextPresets";

const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const HINT: CSSProperties = {
  margin: "var(--space-1) 0 0",
  fontSize: "var(--font-size-sm)",
  color: "var(--fg-muted)",
};

interface ModeContextFieldProps {
  /** Owned by the dialog (`useReducer(contextFieldReducer, …, initContextField)`). */
  state: ContextFieldState;
  dispatch: Dispatch<ContextFieldAction>;
  /** Error id the textarea should be described by (the dialog's inline error). */
  errorId?: string;
}

/**
 * "Context preset" radios + "Context" textarea for the New/Edit mode dialogs.
 * Behaviour lives in `lib/modeContextPresets.ts` (the reducer). The dialog
 * owns the reducer state (it outlives `Dialog`'s children, which unmount while
 * closed), so Save always sends `state.text` — what is shown.
 */
export function ModeContextField({ state, dispatch, errorId }: ModeContextFieldProps) {
  const selection = selectionOf(state);
  // Polite live-region text: set only when TYPING moved the radio (a radio
  // click is announced by the radio itself).
  const [announcement, setAnnouncement] = useState("");
  const groupName = useId();
  const hintId = useId();
  const groupRef = useRef<HTMLFieldSetElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // After the confirm closes, move focus to the radio that is now checked
  // (Custom on Cancel, the new preset on Replace). This passive effect runs
  // after the confirm Dialog's own cleanup scheduled its focus-restore
  // timeout, so our timeout lands last and wins.
  const prevPending = useRef(state.pending);
  useEffect(() => {
    const was = prevPending.current;
    prevPending.current = state.pending;
    if (was === null || state.pending !== null) return undefined;
    const target = selection;
    const t = window.setTimeout(() => {
      groupRef.current
        ?.querySelector<HTMLInputElement>(`input[type="radio"][value="${target}"]`)
        ?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [state.pending, selection]);

  const pendingLabel = state.pending ? presetById(state.pending).label : "";
  const confirmMessage = `Your custom context will be replaced with the “${pendingLabel}” preset. You can bring it back by selecting Custom before you close this dialog.`;

  const showRestoreHint = canRestoreStash(state);
  const showEmptyHint = selection === "custom" && normalizeContext(state.text) === "";
  const describedBy = [showRestoreHint || showEmptyHint ? hintId : null, errorId ?? null]
    .filter(Boolean)
    .join(" ");

  const options: { value: ContextSelection; label: string }[] = [
    ...MODE_CONTEXT_PRESETS.map((p) => ({ value: p.id as ContextSelection, label: p.label })),
    { value: "custom", label: "Custom" },
  ];

  return (
    <>
      <fieldset
        ref={groupRef}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <legend className="field-label" style={{ padding: 0 }}>
          Context preset
        </legend>
        {options.map((o) => (
          <Radio
            key={o.value}
            name={groupName}
            value={o.value}
            label={o.label}
            checked={selection === o.value}
            onChange={() => {
              setAnnouncement("");
              if (o.value === "custom") dispatch({ type: "selectCustom" });
              else dispatch({ type: "selectPreset", id: o.value });
            }}
            onClick={(e) => {
              // A pointer click on Custom moves straight into the text box
              // (caret at the end). Arrow-key selection (detail 0) keeps
              // focus in the radio group.
              if (o.value !== "custom" || e.detail === 0) return;
              window.setTimeout(() => {
                const ta = textareaRef.current;
                if (!ta) return;
                ta.focus();
                ta.setSelectionRange(ta.value.length, ta.value.length);
              }, 0);
            }}
          />
        ))}
        {showRestoreHint ? (
          <p id={hintId} style={HINT}>
            Your custom text is saved. Select Custom to restore it.
          </p>
        ) : null}
      </fieldset>
      <div className="field-label">Context</div>
      <textarea
        ref={textareaRef}
        aria-label="Mode context"
        aria-describedby={describedBy || undefined}
        value={state.text}
        onChange={(e) => {
          const next = selectionForText(e.target.value);
          if (next !== selection) setAnnouncement(`Context preset: ${selectionLabel(next)}`);
          dispatch({ type: "type", text: e.target.value });
        }}
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
      {showEmptyHint ? (
        <p id={hintId} style={HINT}>
          No extra context. The agent uses only the default instructions.
        </p>
      ) : null}
      <div role="status" aria-live="polite" style={SR_ONLY}>
        {announcement}
      </div>
      <ConfirmDialog
        open={state.pending !== null}
        title="Replace your custom context?"
        message={confirmMessage}
        confirmLabel="Replace"
        onConfirm={() => dispatch({ type: "confirmDiscard" })}
        onCancel={() => dispatch({ type: "cancelDiscard" })}
      />
    </>
  );
}
