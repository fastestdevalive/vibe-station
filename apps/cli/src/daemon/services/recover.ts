/**
 * Boot-time recovery for sessions stuck at `not_started` after an unclean daemon restart.
 */

import { hasSession } from "./tmux.js";
import { getAllProjects, mutateProject } from "../state/project-store.js";
import type { SessionLifecycle } from "../types.js";

export async function recoverNotStartedSessions(): Promise<void> {
  for (const project of getAllProjects()) {
    const decisions = new Map<string, SessionLifecycle>();

    for (const wt of project.worktrees) {
      for (const session of wt.sessions) {
        if (session.lifecycle.state !== "not_started") continue;

        const alive = await hasSession(session.tmuxName);
        if (alive) {
          console.log(`[recover] ${session.id}: tmux pane alive → promote to working`);
          decisions.set(session.id, {
            state: "working",
            reason: "recovered-from-not-started",
            lastTransitionAt: new Date().toISOString(),
          });
        } else {
          console.log(`[recover] ${session.id}: tmux pane missing → mark exited`);
          decisions.set(session.id, {
            state: "exited",
            reason: "daemon-restart-during-spawn",
            lastTransitionAt: new Date().toISOString(),
          });
        }
      }
    }

    if (decisions.size === 0) continue;

    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) => ({
        ...w,
        sessions: w.sessions.map((s) => {
          const next = decisions.get(s.id);
          return next ? { ...s, lifecycle: next } : s;
        }),
      })),
    }));
  }
}
