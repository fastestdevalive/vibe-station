import { create } from "zustand";

/** What the in-progress bar says while a reset/switch request is held open. */
export type ResetProgressKind = "summary" | "waiting";

/**
 * Sessions with a reset/switch request in flight that the user must be able to
 * cancel (Decision 9):
 *
 * - `summary` — the old agent is writing the summary (up to 2 min).
 * - `waiting` — `whenBusy: "wait"`: the current turn is being allowed to finish
 *   (up to the daemon's 10-minute queue bound).
 *
 * Rendered by `ResetPendingBar` in the pane (chat composer area / terminal
 * header overlay) with a Cancel button. Nothing here hides the pane — the
 * blurred `ResetProgressOverlay` is gone.
 */
interface ResetProgressState {
  active: Record<string, ResetProgressKind>;
  start: (sessionId: string, kind: ResetProgressKind) => void;
  finish: (sessionId: string) => void;
}

export const useResetProgress = create<ResetProgressState>((set) => ({
  active: {},
  start: (sessionId, kind) => set((s) => ({ active: { ...s.active, [sessionId]: kind } })),
  finish: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.active)) return s;
      const { [sessionId]: _drop, ...rest } = s.active;
      return { active: rest };
    }),
}));
