import { getAllProjects } from "../../state/project-store.js";

/** Resolve a session ID to its tmux session name, or null if not found. */
export function findTmuxNameForSession(sessionId: string): string | null {
  for (const p of getAllProjects()) {
    for (const w of p.worktrees) {
      const s = w.sessions.find((x) => x.id === sessionId);
      if (s) return s.tmuxName;
    }
  }
  return null;
}
