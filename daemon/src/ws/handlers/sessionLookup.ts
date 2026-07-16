import { getAllProjects } from "../../state/project-store.js";
import type { ProjectRecord, SessionRecord } from "../../types.js";

/**
 * Resolve a session ID to its record — worktree sessions AND direct sessions.
 *
 * Direct sessions live in `project.directSessions` and have no worktree. This
 * returns only `{ project, session }` because that is all any caller needs:
 * sessionOpen, sessionInput and sessionResize each destructure `{ session }`
 * alone.
 *
 * DO NOT add a non-optional `worktree` to this return type. Doing so is what
 * originally made direct sessions structurally unrepresentable here, so this
 * function silently returned null for them and session:open / session:input /
 * session:resize all failed with "Session not found" — while the agent was
 * alive and the REST layer (which uses its own direct-aware lookup) kept
 * working. If a caller ever genuinely needs worktree context, add it as
 * `worktree: WorktreeRecord | null` rather than making direct sessions
 * unrepresentable again.
 */
export function findSessionRecord(
  sessionId: string,
): {
  project: ProjectRecord;
  session: SessionRecord;
} | null {
  for (const project of getAllProjects()) {
    for (const worktree of project.worktrees) {
      const session = worktree.sessions.find((x) => x.id === sessionId);
      if (session) {
        return { project, session };
      }
    }
    // Direct sessions (no worktree) — must be scanned too.
    const directSession = project.directSessions.find((x) => x.id === sessionId);
    if (directSession) {
      return { project, session: directSession };
    }
  }
  return null;
}
