import { create } from "zustand";
import type { CarryOver, QueuedPolicy, WhenBusy } from "@/api/types";

/** Which pane-scoped dialog is open for a session. */
export type PaneDialogKind = "fresh" | "fresh-summary" | "switch" | "previous";

/** Live busy shape the FreshDialog's busy block renders (written by the pane). */
export interface PaneBusy {
  busy: boolean;
  queued: number;
}

/** Options for one `run()` call — the dialog's choices plus retry/fallback extras. */
export interface ResetRunOptions {
  carryOver?: CarryOver;
  modeId?: string;
  channel?: "tmux" | "json";
  whenBusy?: WhenBusy;
  queued?: QueuedPolicy;
  handoff?: boolean;
  handoffText?: string;
}

/** The mode-retry prompt (the session's own mode is gone) and its retry inputs. */
export interface ModePrompt {
  sessionId: string;
  reason: string;
  options: ResetRunOptions;
}

/** The fallback notice after a cancelled/failed summary (Decision 9 / OQ2). */
export interface ResetNotice {
  sessionId: string;
  text: string;
  options: ResetRunOptions;
}

/**
 * Per-pane dialog + notice state (Decision 8).
 *
 * Deliberately a zustand store keyed by session id rather than component state:
 * `PaneDialogHost` lives inside `AgentPaneSlot`, which can unmount/remount as
 * the active tab changes, and a failure notice (or a mode-retry prompt) must
 * survive that remount. Nothing here touches the terminal's React tree.
 */
interface PaneDialogsState {
  dialogs: Record<string, PaneDialogKind>;
  busy: Record<string, PaneBusy>;
  modePrompts: Record<string, ModePrompt>;
  notices: Record<string, ResetNotice>;
  open: (sessionId: string, kind: PaneDialogKind) => void;
  close: (sessionId: string) => void;
  setBusy: (sessionId: string, busy: PaneBusy) => void;
  clearBusy: (sessionId: string) => void;
  setModePrompt: (prompt: ModePrompt) => void;
  clearModePrompt: (sessionId: string) => void;
  setNotice: (notice: ResetNotice) => void;
  clearNotice: (sessionId: string) => void;
  /** Test/demo reset. */
  _reset: () => void;
}

export const usePaneDialogs = create<PaneDialogsState>()((set) => ({
  dialogs: {},
  busy: {},
  modePrompts: {},
  notices: {},
  open: (sessionId, kind) => set((s) => ({ dialogs: { ...s.dialogs, [sessionId]: kind } })),
  close: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.dialogs)) return s;
      const { [sessionId]: _drop, ...rest } = s.dialogs;
      return { dialogs: rest };
    }),
  setBusy: (sessionId, busy) => set((s) => ({ busy: { ...s.busy, [sessionId]: busy } })),
  clearBusy: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.busy)) return s;
      const { [sessionId]: _drop, ...rest } = s.busy;
      return { busy: rest };
    }),
  setModePrompt: (prompt) => set((s) => ({ modePrompts: { ...s.modePrompts, [prompt.sessionId]: prompt } })),
  clearModePrompt: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.modePrompts)) return s;
      const { [sessionId]: _drop, ...rest } = s.modePrompts;
      return { modePrompts: rest };
    }),
  setNotice: (notice) => set((s) => ({ notices: { ...s.notices, [notice.sessionId]: notice } })),
  clearNotice: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.notices)) return s;
      const { [sessionId]: _drop, ...rest } = s.notices;
      return { notices: rest };
    }),
  _reset: () => set({ dialogs: {}, busy: {}, modePrompts: {}, notices: {} }),
}));

/** Demo hard-reset (see `lib/demoRuntime.ts`). */
export function __resetPaneDialogsForDemo(): void {
  usePaneDialogs.getState()._reset();
}
