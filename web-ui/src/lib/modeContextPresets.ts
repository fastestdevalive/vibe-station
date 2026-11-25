/**
 * Mode "Context preset" radios + Context text — the pure model behind
 * `components/dialogs/ModeContextField.tsx`.
 *
 * The one rule: the selected radio always DESCRIBES the text. Text equal to a
 * preset (after `normalizeContext`) selects that preset, anything else selects
 * Custom. Choosing a preset replaces the text (asking first when that would
 * throw away custom content); choosing Custom never changes the text.
 * Discarded custom text is stashed so Custom can bring it back until the
 * dialog closes.
 *
 * The daemon persists no preset id (`Mode` in rust/vst-types has none and
 * `CreateModeBody.preset_id` is dropped), so a saved mode's preset is always
 * derived from its text here — never read `Mode.presetId`.
 */

export type ContextPresetId = "bug-fix-with-pr" | "planning-no-pr";
export type ContextSelection = ContextPresetId | "custom";

export interface ContextPreset {
  id: ContextPresetId;
  label: string;
  text: string;
}

export const PRESET_BUG_FIX_TEXT =
  "You are fixing a bug. Open a PR when done. Run tests before committing.";
export const PRESET_PLANNING_TEXT =
  "You are planning. Do not commit or open a PR. Output a written plan.";

export const MODE_CONTEXT_PRESETS: readonly ContextPreset[] = [
  { id: "bug-fix-with-pr", label: "Bug fix with PR", text: PRESET_BUG_FIX_TEXT },
  { id: "planning-no-pr", label: "Planning without PR", text: PRESET_PLANNING_TEXT },
];

export const DEFAULT_CONTEXT_PRESET: ContextPresetId = "bug-fix-with-pr";

/** Mirrors `MAX_CONTEXT_LEN` (bytes, measured after trim) in rust/vst-routes/src/modes.rs. */
export const MAX_CONTEXT_BYTES = 10_000;

export function presetById(id: ContextPresetId): ContextPreset {
  const p = MODE_CONTEXT_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown context preset ${id}`);
  return p;
}

/** Line endings normalised and ends trimmed — the daemon trims on save. */
export function normalizeContext(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export function matchPreset(text: string): ContextPresetId | null {
  const n = normalizeContext(text);
  return MODE_CONTEXT_PRESETS.find((p) => normalizeContext(p.text) === n)?.id ?? null;
}

/** True when replacing `text` would lose something the user wrote. */
export function hasCustomContent(text: string): boolean {
  return normalizeContext(text) !== "" && matchPreset(text) === null;
}

export function contextByteLength(text: string): number {
  return new TextEncoder().encode(text.trim()).length;
}

export function contextTooLong(text: string): boolean {
  return contextByteLength(text) > MAX_CONTEXT_BYTES;
}

export const CONTEXT_TOO_LONG_MESSAGE = `Context must be at most ${MAX_CONTEXT_BYTES.toLocaleString("en-US")} bytes.`;

export function selectionLabel(sel: ContextSelection): string {
  return sel === "custom" ? "Custom" : presetById(sel).label;
}

export interface ContextFieldState {
  text: string;
  /** Custom was chosen while the text still equals a preset. Typing or choosing a preset clears it. */
  forceCustom: boolean;
  /**
   * The last custom text a preset replaced, and the preset text that replaced
   * it (session-only). Custom restores it only while the box still holds
   * exactly that preset text — see `canRestoreStash`.
   */
  stash: { text: string; presetText: string } | null;
  /** Preset awaiting confirmation; the confirm dialog is open while set. */
  pending: ContextPresetId | null;
}

export type ContextFieldAction =
  | { type: "reset"; savedText?: string | null }
  | { type: "type"; text: string }
  | { type: "selectPreset"; id: ContextPresetId }
  | { type: "selectCustom" }
  | { type: "confirmDiscard" }
  | { type: "cancelDiscard" };

/** The radio the text implies: a preset on an exact (normalised) match, else Custom. */
export function selectionForText(text: string): ContextSelection {
  return matchPreset(text) ?? "custom";
}

/** The checked radio — always derived from the text (plus an explicit Custom). */
export function selectionOf(state: ContextFieldState): ContextSelection {
  return state.forceCustom ? "custom" : selectionForText(state.text);
}

/** Whether Custom would bring back stashed text (the box still holds the replacing preset). */
export function canRestoreStash(state: ContextFieldState): boolean {
  return state.stash !== null && state.text === state.stash.presetText;
}

/**
 * `savedText` undefined/null → a NEW mode (starts on the default preset);
 * a string → an existing mode's stored context.
 */
export function initContextField(savedText?: string | null): ContextFieldState {
  return {
    text: savedText ?? presetById(DEFAULT_CONTEXT_PRESET).text,
    forceCustom: false,
    stash: null,
    pending: null,
  };
}

export function contextFieldReducer(
  state: ContextFieldState,
  action: ContextFieldAction,
): ContextFieldState {
  switch (action.type) {
    case "reset":
      return initContextField(action.savedText);
    case "type":
      return { ...state, text: action.text, forceCustom: false };
    case "selectPreset": {
      if (action.id === selectionOf(state) && state.pending === null) return state;
      if (hasCustomContent(state.text)) return { ...state, pending: action.id };
      const text = presetById(action.id).text;
      // Preset → preset over untouched preset text keeps the stash restorable.
      const stash = canRestoreStash(state) ? { ...state.stash!, presetText: text } : state.stash;
      return { ...state, text, stash, forceCustom: false, pending: null };
    }
    case "confirmDiscard": {
      if (state.pending === null) return state;
      const text = presetById(state.pending).text;
      return {
        ...state,
        stash: { text: state.text, presetText: text },
        text,
        forceCustom: false,
        pending: null,
      };
    }
    case "cancelDiscard":
      return state.pending === null ? state : { ...state, pending: null };
    case "selectCustom": {
      if (canRestoreStash(state)) {
        return { ...state, text: state.stash!.text, stash: null, forceCustom: false };
      }
      if (selectionOf(state) === "custom") return state;
      return { ...state, forceCustom: true };
    }
    default:
      return state;
  }
}

/** `presetId` to send on create: the preset the text actually is, else undefined (Custom). */
export function presetIdForSave(text: string): ContextPresetId | undefined {
  return matchPreset(text) ?? undefined;
}
