import { create } from "zustand";
import type { ScheduleSnapshot } from "@/api/types";

/**
 * Dev-only client override for a session's scheduled-send state, written by the
 * state simulator (`components/dev/DevStatePanel.tsx`, Ctrl+Shift+D). Like the
 * simulator's session-state patches it never touches the daemon: when a session has
 * an entry here `useScheduledSends` shows it instead of the fetched state, so the
 * Terminal waiting / pasting / sent / failed rows can be inspected without a
 * running agent. A reload (or "Clear") drops it; server truth wins again.
 */
interface ScheduleDevOverrideState {
  bySession: Record<string, ScheduleSnapshot>;
  set: (sessionId: string, snapshot: ScheduleSnapshot) => void;
  clear: (sessionId: string) => void;
}

export const useScheduleDevOverride = create<ScheduleDevOverrideState>((set) => ({
  bySession: {},
  set: (sessionId, snapshot) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: snapshot } })),
  clear: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),
}));

export const SCHEDULE_DEV_SCENARIOS = ["pending", "waiting", "pasting", "sent", "timed out", "failed", "all states"] as const;
export type ScheduleDevScenario = (typeof SCHEDULE_DEV_SCENARIOS)[number];

/** A canned Terminal (tmux) snapshot for the state simulator (R100). */
export function devScheduleSnapshot(scenario: ScheduleDevScenario, now: number = Date.now()): ScheduleSnapshot {
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const pending = (id: string, message: string, phase: "scheduled" | "waiting" | "pasting", extra = {}) => ({
    id,
    message,
    fireAt: phase === "scheduled" ? iso(3_600_000) : iso(-30_000),
    channel: "tmux" as const,
    phase,
    ...extra,
  });
  const sent = {
    id: "dev-sent",
    message: "/review src/auth",
    fireAt: iso(-120_000),
    sentAt: iso(-60_000),
    channel: "tmux" as const,
  };
  const timedOut = {
    id: "dev-timeout",
    message: "Run the linter",
    fireAt: iso(-700_000),
    failureReason: "Not ready within 10 min",
    failureKind: "timed_out" as const,
    channel: "tmux" as const,
  };
  const failed = {
    id: "dev-failed",
    message: "Summarise today",
    fireAt: iso(-700_000),
    failureReason: "Agent exited, not delivered",
    failureKind: "agent_exited" as const,
    channel: "tmux" as const,
  };
  const empty: ScheduleSnapshot = { scheduledSends: [], scheduledFailed: [], scheduledSent: [] };
  switch (scenario) {
    case "pending":
      return { ...empty, scheduledSends: [pending("dev-pending", "Fix the failing tests", "scheduled", { commentCount: 2 })] };
    case "waiting":
      return { ...empty, scheduledSends: [pending("dev-waiting", "/review src/auth", "waiting")] };
    case "pasting":
      return { ...empty, scheduledSends: [pending("dev-pasting", "/review src/auth", "pasting")] };
    case "sent":
      return { ...empty, scheduledSent: [sent] };
    case "timed out":
      return { ...empty, scheduledFailed: [timedOut] };
    case "failed":
      return { ...empty, scheduledFailed: [failed] };
    case "all states":
      return {
        scheduledSends: [
          pending("dev-pending", "Fix the failing tests", "scheduled", { commentCount: 2 }),
          pending("dev-waiting", "/review src/auth", "waiting"),
          pending("dev-pasting", "/review src/auth", "pasting"),
        ],
        scheduledFailed: [timedOut, failed],
        scheduledSent: [sent],
      };
  }
}
