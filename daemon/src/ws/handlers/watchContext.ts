import { resolveContext, resolveWorktreeById } from "../../services/context.js";
import type { ResolvedContext } from "../../services/context.js";

/** The wire shape of a context ref (see protocol.ts WsContextRef). */
export interface WireContextRef {
  kind: "worktree" | "project";
  id: string;
}

/**
 * Resolve a wire context ref to a full context.
 *
 * The two kinds resolve differently: a project ref carries the project id
 * directly, while a worktree ref carries only the worktree id (the legacy wire
 * shape has no projectId), so it needs a scan to find its owner.
 *
 * Kept explicit rather than using resolveContextById, which falls back from
 * worktree to project on a miss — here the kind is known, and a worktree id
 * that no longer exists must resolve to null rather than silently matching a
 * same-named project.
 */
export function resolveWatchContext(ref: WireContextRef): ResolvedContext | null {
  return ref.kind === "project"
    ? resolveContext({ kind: "project", projectId: ref.id })
    : resolveWorktreeById(ref.id);
}
