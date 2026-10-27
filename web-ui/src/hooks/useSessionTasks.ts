import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskSummary } from "@/api/types";
import { useTaskStore } from "@/hooks/useTaskStore";
import { useNowTick } from "@/hooks/useNowTick";
import { groupTasks, type TaskGroups } from "@/components/tasks/taskFormat";

const OPEN_KEY = (sessionId: string) => `vst.taskView.${sessionId}`;
const EXPANDED_KEY = "vst.taskTray.expanded";

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the view still works for this page load */
  }
}

export interface SessionTasks extends TaskGroups {
  /** `undefined` until the first snapshot of this connection arrived. */
  tasks: TaskSummary[] | undefined;
  openTask: TaskSummary | undefined;
  openTaskId: string | null;
  open: (id: string) => void;
  close: () => void;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  /** One-shot "no longer tracked" text; call `ackLostNotice` once shown. */
  lostNotice: string | null;
  ackLostNotice: () => void;
}

interface Local {
  sessionId: string | null;
  openTaskId: string | null;
}
const load = (sessionId: string | null): Local => ({
  sessionId,
  openTaskId: sessionId ? readStore(OPEN_KEY(sessionId)) : null,
});

/**
 * Selector over {@link useTaskStore} plus the per-session task-view state. Has NO subscription of its own
 * (`ChatPane` is not re-keyed per session, so everything is keyed by `sessionId`).
 */
export function useSessionTasks(sessionId: string | null): SessionTasks {
  const tasks = useTaskStore((s) => (sessionId ? s.tasksBySession[sessionId] : undefined));
  const now = useNowTick();
  const [local, setLocal] = useState<Local>(() => load(sessionId));
  const [expanded, setExpandedState] = useState(() => readStore(EXPANDED_KEY) === "1");
  // Last real snapshot's view of the open task: survives a transient `reset()` (WS reconnect) so the view does not remount.
  const lastOpen = useRef<{ sessionId: string | null; task: TaskSummary } | undefined>(undefined);
  const [lost, setLost] = useState<{ sessionId: string | null; text: string } | null>(null);

  // Session switch: re-read the new session's persisted open task (adjust-state-during-render).
  let cur = local;
  if (local.sessionId !== sessionId) {
    cur = load(sessionId);
    lastOpen.current = undefined;
    setLocal(cur);
  }
  const openTaskId = cur.openTaskId;

  // Prune ONLY against a real snapshot, so a reload keeps the persisted id until tasks arrive (CUJ 9).
  useEffect(() => {
    if (!sessionId || !openTaskId || tasks === undefined) return;
    if (tasks.some((t) => t.id === openTaskId)) return;
    writeStore(OPEN_KEY(sessionId), null);
    setLocal({ sessionId, openTaskId: null });
    setLost({ sessionId, text: "That task is no longer tracked" });
  }, [sessionId, openTaskId, tasks]);

  const open = useCallback(
    (id: string) => {
      if (!sessionId) return;
      writeStore(OPEN_KEY(sessionId), id);
      setLocal({ sessionId, openTaskId: id });
    },
    [sessionId],
  );
  const close = useCallback(() => {
    if (!sessionId) return;
    writeStore(OPEN_KEY(sessionId), null);
    lastOpen.current = undefined;
    setLocal({ sessionId, openTaskId: null });
  }, [sessionId]);
  const setExpanded = useCallback((v: boolean) => {
    writeStore(EXPANDED_KEY, v ? "1" : "0");
    setExpandedState(v);
  }, []);
  const ackLostNotice = useCallback(() => setLost(null), []);

  const groups = useMemo(() => groupTasks(tasks, now), [tasks, now]);
  const found = useMemo(
    () => (openTaskId && tasks ? tasks.find((t) => t.id === openTaskId) : undefined),
    [openTaskId, tasks],
  );
  if (tasks !== undefined) {
    lastOpen.current = found ? { sessionId, task: found } : undefined;
  }
  const kept = lastOpen.current;
  const openTask =
    tasks !== undefined ? found : kept && kept.sessionId === sessionId && kept.task.id === openTaskId ? kept.task : undefined;

  return {
    tasks,
    ...groups,
    openTask,
    openTaskId,
    open,
    close,
    expanded,
    setExpanded,
    lostNotice: lost && lost.sessionId === sessionId ? lost.text : null,
    ackLostNotice,
  };
}
