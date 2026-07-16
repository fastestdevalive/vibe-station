/**
 * Agent context — the thing an agent session runs *in*.
 *
 * An agent is first-class: it exists either inside a git worktree (many agents
 * grouped under one worktree) or directly in the project directory (a "direct"
 * agent, listed individually). Those are two shapes of the same idea, not a
 * thing and the absence of a thing.
 *
 * WHY THIS EXISTS
 *
 * Direct sessions used to be encoded as an *absence* — `worktreeId === null`,
 * or a fabricated placeholder worktree. That shape produced the same bug over
 * and over: code asks "which worktree?", gets nothing, and misreads the absence
 * as *deleted* / *not found* / *impossible*. Real instances:
 *
 *   - ws/handlers/sessionLookup.ts scanned only worktrees, so session:open for
 *     a direct session answered "Session not found" while the agent was alive.
 *   - routes/modes.ts isModeInUse ignored direct sessions, so a mode in use
 *     could be deleted.
 *   - A fabricated worktree (`<project>-direct`) resolved to a NONEXISTENT
 *     directory, so plugins derived paths that silently pointed nowhere.
 *
 * Encoding the context as a *value* removes the null there is to misread: a
 * direct context resolves successfully to its project, so "cannot resolve" can
 * only ever mean genuinely gone.
 *
 * THE RULE
 *
 * Consumers may read `ResolvedContext.worktree` and gate on its presence —
 * some things (git diff/branch, worktree lifecycle, VST_WORKTREE) are
 * legitimately worktree-only. What they must NOT do is fabricate a worktree,
 * or infer "direct" from an unrelated null.
 */

import { getAllProjects } from "../state/project-store.js";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../types.js";
import {
  worktreePath,
  sessionDataDir,
  directSessionDataDir,
  systemPromptPath,
  directSystemPromptPath,
  opencodeConfigPath,
  directOpencodeConfigPath,
} from "./paths.js";
import { join } from "node:path";

/**
 * Serializable reference to a context. Safe to persist and to send over the
 * wire. Carries projectId in both shapes because every consumer needs it.
 */
export type AgentContextRef =
  | { kind: "worktree"; projectId: string; worktreeId: string }
  | { kind: "project"; projectId: string };

/**
 * A ref resolved against the project store. Never persisted — always computed,
 * so it cannot go stale.
 */
export interface ResolvedContext {
  ref: AgentContextRef;
  project: ProjectRecord;
  /** null ⇔ ref.kind === "project". Gate on this; never fabricate one. */
  worktree: WorktreeRecord | null;
  /** Where the agent actually runs: the worktree checkout, or the project dir. */
  cwd: string;
}

/** Stable key for maps/registries: the worktree id, or the project id. */
export function contextKey(ref: AgentContextRef): string {
  return ref.kind === "worktree" ? ref.worktreeId : ref.projectId;
}

/** Build a ref from records already in hand. */
export function contextRefOf(
  project: ProjectRecord,
  worktree: WorktreeRecord | null,
): AgentContextRef {
  return worktree
    ? { kind: "worktree", projectId: project.id, worktreeId: worktree.id }
    : { kind: "project", projectId: project.id };
}

/** Resolve a ref against the store. Returns null only if it genuinely no longer exists. */
export function resolveContext(ref: AgentContextRef): ResolvedContext | null {
  const project = getAllProjects().find((p) => p.id === ref.projectId);
  if (!project) return null;

  if (ref.kind === "project") {
    return { ref, project, worktree: null, cwd: project.absolutePath };
  }

  const worktree = project.worktrees.find((w) => w.id === ref.worktreeId);
  if (!worktree) return null;
  return { ref, project, worktree, cwd: worktreePath(project.id, worktree.id) };
}

/** Resolve directly from records, skipping the store lookup. */
export function resolvedContextOf(
  project: ProjectRecord,
  worktree: WorktreeRecord | null,
): ResolvedContext {
  return {
    ref: contextRefOf(project, worktree),
    project,
    worktree,
    cwd: worktree ? worktreePath(project.id, worktree.id) : project.absolutePath,
  };
}

/**
 * Resolve a worktree by id alone, scanning projects. Needed because the legacy
 * wire shape carries a bare worktreeId with no projectId.
 */
export function resolveWorktreeById(worktreeId: string): ResolvedContext | null {
  for (const project of getAllProjects()) {
    const worktree = project.worktrees.find((w) => w.id === worktreeId);
    if (worktree) return resolvedContextOf(project, worktree);
  }
  return null;
}

/**
 * Resolve a *worktree-or-project id* — the shape older wire messages use, where
 * a single id field carries either. Prefers a worktree match, then a project.
 * Prefer an explicit AgentContextRef; this exists for back-compat only.
 */
export function resolveContextById(id: string): ResolvedContext | null {
  const asWorktree = resolveWorktreeById(id);
  if (asWorktree) return asWorktree;
  const project = getAllProjects().find((p) => p.id === id);
  return project ? resolvedContextOf(project, null) : null;
}

/**
 * Find a session and the context it runs in — worktree sessions AND direct
 * sessions. This is the single lookup: the daemon previously had two (a
 * direct-aware one in routes, a worktree-only one in ws/handlers), and the
 * WS layer silently failed for every direct session as a result.
 */
export function contextForSession(
  sessionId: string,
): { ctx: ResolvedContext; session: SessionRecord } | null {
  for (const project of getAllProjects()) {
    for (const worktree of project.worktrees) {
      const session = worktree.sessions.find((s) => s.id === sessionId);
      if (session) return { ctx: resolvedContextOf(project, worktree), session };
    }
    const direct = project.directSessions.find((s) => s.id === sessionId);
    if (direct) return { ctx: resolvedContextOf(project, null), session: direct };
  }
  return null;
}

// ── Context-keyed path helpers ───────────────────────────────────────────────
// paths.ts keeps parallel worktree/direct families; these route to the right
// one so callers never branch on "is this direct?" themselves.

/** Per-session data dir for this context. */
export function sessionDataDirFor(ctx: ResolvedContext, sessionId: string): string {
  return ctx.worktree
    ? sessionDataDir(ctx.project.id, ctx.worktree.id, sessionId)
    : directSessionDataDir(ctx.project.id, sessionId);
}

/** <sessionDataDir>/system-prompt.md for this context. */
export function systemPromptPathFor(ctx: ResolvedContext, sessionId: string): string {
  return ctx.worktree
    ? systemPromptPath(ctx.project.id, ctx.worktree.id, sessionId)
    : directSystemPromptPath(ctx.project.id, sessionId);
}

/** <sessionDataDir>/opencode-config.json for this context. */
export function opencodeConfigPathFor(ctx: ResolvedContext, sessionId: string): string {
  return ctx.worktree
    ? opencodeConfigPath(ctx.project.id, ctx.worktree.id, sessionId)
    : directOpencodeConfigPath(ctx.project.id, sessionId);
}

/** Absolute path of `relPath` inside this context's working directory. */
export function pathInContext(ctx: ResolvedContext, relPath: string): string {
  return join(ctx.cwd, relPath);
}
