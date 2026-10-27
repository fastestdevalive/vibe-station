import { create } from "zustand";
import type { ApiInstance } from "@/api";
import type { TaskSummary } from "@/api/types";

/**
 * Background-task snapshots per session (`session:tasks`, full replace, never a diff).
 * `undefined` for a session = no snapshot yet on this connection (distinct from an empty list).
 * The daemon's `rev` is `max(prev+1, unix_ms)` per session, but empty snapshots (release, unresolved agent)
 * and clock skew can make a held rev newer than a later legitimate one, so the held revs are dropped on every
 * reconnect (`reset`) before the `chat:open` replay delivers fresh ones.
 */
interface TaskState {
  tasksBySession: Record<string, TaskSummary[] | undefined>;
  revBySession: Record<string, number | undefined>;
  applySnapshot: (sessionId: string, rev: number, tasks: TaskSummary[]) => void;
  reset: () => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasksBySession: {},
  revBySession: {},
  applySnapshot: (sessionId, rev, tasks) => {
    const held = get().revBySession[sessionId];
    if (held !== undefined && rev <= held) return;
    set((s) => ({
      tasksBySession: { ...s.tasksBySession, [sessionId]: tasks },
      revBySession: { ...s.revBySession, [sessionId]: rev },
    }));
  },
  reset: () => set({ tasksBySession: {}, revBySession: {} }),
}));

const subscribed = new WeakSet<object>();

/**
 * Idempotent: ONE `session:tasks` subscription and ONE connection watcher per api instance. Called by
 * `useChat` right before `openChat` (a mock may emit its snapshot synchronously inside it).
 */
export function ensureTaskSubscription(api: ApiInstance): void {
  if (subscribed.has(api)) return;
  subscribed.add(api);
  // Partial test doubles (hook tests pass hand-rolled apis) may lack these; a real api never does.
  const a = api as Partial<Pick<ApiInstance, "on" | "subscribeConnection">>;
  a.on?.("session:tasks", (e) => {
    if (e.type === "session:tasks") useTaskStore.getState().applySnapshot(e.sessionId, e.rev, e.tasks);
  });
  let prev: string | undefined;
  a.subscribeConnection?.((s) => {
    // Runs synchronously on the transition to online, i.e. before the chat:open replay.
    if (s === "online" && prev !== undefined && prev !== "online") useTaskStore.getState().reset();
    prev = s;
  });
}
