import type { ArtifactRow, ArtifactScopeKind, Session, SessionState } from "@/api/types";
import { sessionLabel } from "@/lib/sessionLabel";

export type ArtifactGroupId = "pinned" | "run" | "earlier";

/** Sessions that can write artifacts in this scope (worktree sessions, or a project's direct sessions). */
export function scopeSessions(sessions: Session[], scope: ArtifactScopeKind, scopeId: string): Session[] {
  return sessions.filter((s) => (scope === "worktree" ? s.worktreeId === scopeId : s.projectId === scopeId && !s.worktreeId));
}

/** Walk `parentSessionId` up to the top-level session (cycle-guarded); an unknown parent ends the walk. */
export function rootSessionId(id: string, byId: Map<string, Session>): string {
  let cur = id;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const parent = byId.get(cur)?.parentSessionId;
    if (!parent || !byId.has(parent)) break;
    cur = parent;
  }
  return cur;
}

/** Top-level agent sessions offered by the filter: children fold under their parent, archived/superseded/draft are not options. */
export function filterSessions(scoped: Session[]): Session[] {
  const byId = new Map(scoped.map((s) => [s.id, s]));
  return scoped.filter(
    (s) =>
      s.type === "agent" &&
      !s.archivedAt &&
      !s.supersededBy &&
      s.state !== "drafting" &&
      rootSessionId(s.id, byId) === s.id,
  );
}

/**
 * A session is live when it exists, is not archived and its state is not done/exited. State resolves via
 * `sessionStates[id] ?? session.state` (never `.lifecycleState`, which is a one-shot initial value).
 */
export function isLiveSession(session: Session | undefined, sessionStates: Record<string, SessionState>): boolean {
  if (!session || session.archivedAt) return false;
  const state = sessionStates[session.id] ?? session.state;
  return state !== "done" && state !== "exited";
}

/** Pinned, else ANY live writer ⇒ This run, else Earlier (a deleted writer is not live). */
export function groupOf(row: ArtifactRow, byId: Map<string, Session>, sessionStates: Record<string, SessionState>): ArtifactGroupId {
  if (row.pinned) return "pinned";
  return row.writers.some((w) => isLiveSession(byId.get(w), sessionStates)) ? "run" : "earlier";
}

/** Filter match: any writer whose top-level ancestor is the selected session (R16 children, R21 any writer). */
export function matchesSession(row: ArtifactRow, selectedId: string, byId: Map<string, Session>): boolean {
  return row.writers.some((w) => byId.has(w) && rootSessionId(w, byId) === selectedId);
}

export const DELETED_AGENT_LABEL = "deleted agent";

/**
 * The writer to display: the first writer whose root session is `selectedId` when one is given (the same
 * predicate as `matchesSession`), else `writers[0]`.
 * `undefined` when no writer is recorded, `null` when it is an unknown (deleted) session.
 */
export function writerOf(row: ArtifactRow, byId: Map<string, Session>, selectedId?: string): Session | null | undefined {
  const w = row.writers[0];
  if (w == null) return undefined;
  if (selectedId) {
    const match = row.writers.find((id) => byId.has(id) && rootSessionId(id, byId) === selectedId);
    if (match != null) return byId.get(match) ?? null;
  }
  return byId.get(w) ?? null;
}

/** Number of unique writers beyond the displayed writer (the first, or the filtered agent's match). */
export function otherWriterCount(row: ArtifactRow): number {
  return Math.max(0, new Set(row.writers).size - 1);
}

/** Other writers' labels joined with ", " (`sessionLabel`, or `DELETED_AGENT_LABEL`), excluding the displayed writer. */
export function otherWriterNames(row: ArtifactRow, byId: Map<string, Session>, displayedWriter?: Session | null): string {
  const displayedId = displayedWriter?.id;
  const seen = new Set<string>();
  const others: string[] = [];
  let skippedDisplayed = false;
  for (const w of row.writers) {
    if (seen.has(w)) continue;
    seen.add(w);
    if (!skippedDisplayed) {
      if (displayedId ? w === displayedId : displayedWriter === null && !byId.has(w)) {
        skippedDisplayed = true;
        continue;
      }
    }
    const s = byId.get(w);
    others.push(s ? sessionLabel(s) : DELETED_AGENT_LABEL);
  }
  return others.join(", ");
}

/** Newest writer's label, or "deleted agent" for an unknown session. */
export function writerLabel(row: ArtifactRow, byId: Map<string, Session>): string | null {
  const s = writerOf(row, byId);
  if (s === undefined) return null;
  return s ? sessionLabel(s) : DELETED_AGENT_LABEL;
}

export function baseName(displayPath: string): string {
  const i = displayPath.lastIndexOf("/");
  return i < 0 ? displayPath : displayPath.slice(i + 1);
}

/** Directory part with a trailing slash (`docs/`, `~/.claude/plans/`); "" for a root-level file. */
export function dirOf(displayPath: string): string {
  const i = displayPath.lastIndexOf("/");
  return i < 0 ? "" : displayPath.slice(0, i + 1);
}

export function artifactCount(n: number): string {
  return `${n} ${n === 1 ? "artifact" : "artifacts"}`;
}
