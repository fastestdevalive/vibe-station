/**
 * Boot-time recovery for sessions stuck at `not_started` after an unclean daemon restart.
 */

import { hasSession } from "./tmux.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { getAllProjects, mutateProject } from "../state/project-store.js";
import type { SessionLifecycle } from "../types.js";

export async function recoverNotStartedSessions(): Promise<void> {
  for (const project of getAllProjects()) {
    const worktreeDecisions = new Map<string, SessionLifecycle>();
    const directDecisions = new Map<string, SessionLifecycle>();

    // Recover worktree sessions
    for (const wt of project.worktrees) {
      for (const session of wt.sessions) {
        if (session.lifecycle.state !== "not_started") continue;

        if (session.useTmux === false) {
          // Direct-pty sessions can't survive a daemon restart.
          // The registry will be empty on boot, so treat as exited.
          const alive = directPtyRegistry.has(session.id);
          if (alive) {
            console.log(`[recover] ${session.id}: direct-pty stream alive → promote to working`);
            worktreeDecisions.set(session.id, {
              state: "working",
              reason: "recovered-from-not-started",
              lastTransitionAt: new Date().toISOString(),
            });
          } else {
            console.log(`[recover] ${session.id}: direct-pty not found → mark exited`);
            worktreeDecisions.set(session.id, {
              state: "exited",
              reason: "daemon-restart-during-spawn",
              lastTransitionAt: new Date().toISOString(),
            });
          }
          continue;
        }

        const alive = await hasSession(session.tmuxName);
        if (alive) {
          console.log(`[recover] ${session.id}: tmux pane alive → promote to working`);
          worktreeDecisions.set(session.id, {
            state: "working",
            reason: "recovered-from-not-started",
            lastTransitionAt: new Date().toISOString(),
          });
        } else {
          console.log(`[recover] ${session.id}: tmux pane missing → mark exited`);
          worktreeDecisions.set(session.id, {
            state: "exited",
            reason: "daemon-restart-during-spawn",
            lastTransitionAt: new Date().toISOString(),
          });
        }
      }
    }

    // Recover direct sessions
    for (const session of project.directSessions) {
      if (session.lifecycle.state !== "not_started") continue;

      if (session.useTmux === false) {
        const alive = directPtyRegistry.has(session.id);
        if (alive) {
          console.log(`[recover] ${session.id}: direct-pty stream alive → promote to working`);
          directDecisions.set(session.id, {
            state: "working",
            reason: "recovered-from-not-started",
            lastTransitionAt: new Date().toISOString(),
          });
        } else {
          console.log(`[recover] ${session.id}: direct-pty not found → mark exited`);
          directDecisions.set(session.id, {
            state: "exited",
            reason: "daemon-restart-during-spawn",
            lastTransitionAt: new Date().toISOString(),
          });
        }
        continue;
      }

      const alive = await hasSession(session.tmuxName);
      if (alive) {
        console.log(`[recover] ${session.id}: tmux pane alive → promote to working`);
        directDecisions.set(session.id, {
          state: "working",
          reason: "recovered-from-not-started",
          lastTransitionAt: new Date().toISOString(),
        });
      } else {
        console.log(`[recover] ${session.id}: tmux pane missing → mark exited`);
        directDecisions.set(session.id, {
          state: "exited",
          reason: "daemon-restart-during-spawn",
          lastTransitionAt: new Date().toISOString(),
        });
      }
    }

    if (worktreeDecisions.size === 0 && directDecisions.size === 0) continue;

    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) => ({
        ...w,
        sessions: w.sessions.map((s) => {
          const next = worktreeDecisions.get(s.id);
          return next ? { ...s, lifecycle: next } : s;
        }),
      })),
      directSessions: p.directSessions.map((s) => {
        const next = directDecisions.get(s.id);
        return next ? { ...s, lifecycle: next } : s;
      }),
    }));
  }
}
