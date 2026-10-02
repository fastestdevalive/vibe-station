import { create } from "zustand";

/**
 * Sessions with a "Reset with handoff" in flight. The handoff holds the reset
 * request open while the old agent writes its summary (10-90s), so the agent's
 * own pane shows a progress overlay (`ResetProgressOverlay`) — scoped to that
 * session, not a page-wide modal. `dismissed` hides the overlay without
 * cancelling anything: the reset keeps running and finishes on its own.
 */
interface ResetProgressState {
  active: Record<string, "shown" | "dismissed">;
  start: (sessionId: string) => void;
  dismiss: (sessionId: string) => void;
  finish: (sessionId: string) => void;
}

export const useResetProgress = create<ResetProgressState>((set) => ({
  active: {},
  start: (sessionId) => set((s) => ({ active: { ...s.active, [sessionId]: "shown" } })),
  dismiss: (sessionId) =>
    set((s) => (sessionId in s.active ? { active: { ...s.active, [sessionId]: "dismissed" } } : s)),
  finish: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.active)) return s;
      const { [sessionId]: _drop, ...rest } = s.active;
      return { active: rest };
    }),
}));
