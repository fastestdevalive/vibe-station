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

import type { ProjectRecord, WorktreeRecord } from "../types.js";
import {
  worktreePath,
  sessionDataDir,
  directSessionDataDir,
  systemPromptPath,
  directSystemPromptPath,
  opencodeConfigPath,
  directOpencodeConfigPath,
} from "./paths.js";

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

/**
 * Resolve directly from records already in hand — the only resolver the spawn
 * and resume paths need. (Store-lookup resolvers by ref or by bare id are
 * added when the watch subsystem needs them; see
 * .feature-plans/pending/direct-session-live-file-watch.md.)
 */
export function resolvedContextOf(
  project: ProjectRecord,
  worktree: WorktreeRecord | null,
): ResolvedContext {
  const ref: AgentContextRef = worktree
    ? { kind: "worktree", projectId: project.id, worktreeId: worktree.id }
    : { kind: "project", projectId: project.id };
  return {
    ref,
    project,
    worktree,
    cwd: worktree ? worktreePath(project.id, worktree.id) : project.absolutePath,
  };
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
