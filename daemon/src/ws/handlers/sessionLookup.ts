// @ts-nocheck
import { getAllProjects } from "../../state/project-store.js";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../../types.js";

/** Resolve a session ID to its full session record, or null if not found. */
export function findSessionRecord(
  sessionId: string,
): {
  project: ProjectRecord;
  worktree: WorktreeRecord;
  session: SessionRecord;
} | null {
  for (const project of getAllProjects()) {
    for (const worktree of project.worktrees) {
      const session = worktree.sessions.find((x) => x.id === sessionId);
      if (session) {
        return { project, worktree, session };
      }
    }
  }
  return null;
}

