/**
 * Row <-> record mappers for `vibe-station.db` (Decision 8).
 *
 * `better-sqlite3` returns `0`/`1` for INTEGER "boolean" columns, never
 * `true`/`false` — `rowToBool` is the single coercion point so this isn't
 * reimplemented ad hoc (and inevitably forgotten) at each call site.
 */
import type { ProjectRecord, SessionRecord, WorktreeRecord, TranscriptRef, PrStatus } from "../types.js";
import { resolveUseTmux } from "../services/resolveUseTmux.js";

export function rowToBool(v: number): boolean {
  return v === 1;
}
export function boolToRow(v: boolean | undefined): number {
  return v ? 1 : 0;
}

export interface SessionRow {
  id: string;
  worktreeId: string | null;
  projectId: string;
  isMain: number;
  sortOrder: number;
  type: string;
  modeId: string | null;
  name: string | null;
  nameSource: string | null;
  tmuxName: string;
  useTmux: number;
  channel: string | null;
  state: string;
  reason: string | null;
  lastTransitionAt: string;
  transcriptKind: string | null;
  transcriptPath: string | null;
  agentChatId: string | null;
  modelOverride: string | null;
  pinnedAt: string | null;
  initialPrompt: string | null;
  archivedAt: string | null;
  handoffSummary: string | null;
  spawnedFrom: string | null;
  supersededBy: string | null;
  prState: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prCheckedAt: string | null;
  prBranch: string | null;
}

export function rowToSession(row: SessionRow): SessionRecord {
  const transcriptRef: TranscriptRef | undefined =
    row.transcriptKind != null
      ? { kind: row.transcriptKind as TranscriptRef["kind"], ...(row.transcriptPath != null ? { path: row.transcriptPath } : {}) }
      : undefined;

  const pr: PrStatus | undefined =
    row.prState != null
      ? {
          state: row.prState as PrStatus["state"],
          ...(row.prNumber != null ? { number: row.prNumber } : {}),
          ...(row.prUrl != null ? { url: row.prUrl } : {}),
          checkedAt: row.prCheckedAt ?? "",
          ...(row.prBranch != null ? { prBranch: row.prBranch } : {}),
        }
      : undefined;

  // Back-compat (R10): a row persisted before the PR-status split with
  // `state === "needs_review"` maps to `idle` lifecycle + an open PR, since
  // that was the only thing `needs_review` ever meant. One-way — never
  // written back as `needs_review`.
  const isLegacyNeedsReview = row.state === "needs_review";
  const lifecycleState = (isLegacyNeedsReview ? "idle" : row.state) as SessionRecord["lifecycle"]["state"];
  const legacyPr: PrStatus | undefined = isLegacyNeedsReview && !pr ? { state: "open", checkedAt: "" } : pr;

  return {
    id: row.id,
    ...(row.worktreeId != null ? { worktreeId: row.worktreeId } : {}),
    projectId: row.projectId,
    isMain: rowToBool(row.isMain),
    sortOrder: row.sortOrder,
    type: row.type as SessionRecord["type"],
    ...(row.modeId != null ? { modeId: row.modeId } : {}),
    ...(row.name != null ? { name: row.name } : {}),
    ...(row.nameSource != null ? { nameSource: row.nameSource as SessionRecord["nameSource"] } : {}),
    tmuxName: row.tmuxName,
    useTmux: rowToBool(row.useTmux),
    ...(row.channel != null ? { channel: row.channel as SessionRecord["channel"] } : {}),
    lifecycle: {
      state: lifecycleState,
      ...(row.reason != null ? { reason: row.reason } : {}),
      lastTransitionAt: row.lastTransitionAt,
    },
    ...(transcriptRef ? { transcriptRef } : {}),
    ...(row.agentChatId != null ? { agentChatId: row.agentChatId } : {}),
    ...(row.modelOverride != null ? { modelOverride: row.modelOverride } : {}),
    ...(row.pinnedAt != null ? { pinnedAt: row.pinnedAt } : {}),
    ...(row.initialPrompt != null ? { initialPrompt: row.initialPrompt } : {}),
    ...(row.archivedAt != null ? { archivedAt: row.archivedAt } : {}),
    ...(row.handoffSummary != null ? { handoffSummary: row.handoffSummary } : {}),
    ...(row.spawnedFrom != null ? { spawnedFrom: row.spawnedFrom } : {}),
    ...(row.supersededBy != null ? { supersededBy: row.supersededBy } : {}),
    ...(legacyPr ? { pr: legacyPr } : {}),
  };
}

/**
 * `worktreeId` is passed explicitly (like `projectId`) rather than read off
 * `session.worktreeId` — the array it's stored in (`worktree.sessions` vs.
 * `project.directSessions`) is the actual source of truth for that
 * relationship, and older/hand-built `SessionRecord` fixtures (this field is
 * new) never set it on the record itself.
 */
export function sessionToRow(session: SessionRecord, projectId: string, worktreeId: string | null): SessionRow {
  return {
    id: session.id,
    worktreeId,
    projectId,
    isMain: boolToRow(session.isMain),
    // `?? 0`: defensive default for callers/fixtures built before this field
    // existed (e.g. hand-built SessionRecord test fixtures that never set it)
    // — a real NOT NULL column needs a concrete value even when the in-memory
    // record was constructed without one.
    sortOrder: session.sortOrder ?? 0,
    type: session.type,
    modeId: session.modeId ?? null,
    name: session.name ?? null,
    nameSource: session.nameSource ?? null,
    tmuxName: session.tmuxName,
    // `resolveUseTmux`, not a plain boolToRow: legacy semantics treat an
    // absent `useTmux` as `true` (see services/resolveUseTmux.ts) — a naive
    // `session.useTmux ? 1 : 0` would silently flip an undefined (legacy
    // tmux) session to a direct-pty one the moment it's written to SQL.
    useTmux: boolToRow(resolveUseTmux(session.useTmux)),
    channel: session.channel ?? null,
    state: session.lifecycle.state,
    reason: session.lifecycle.reason ?? null,
    lastTransitionAt: session.lifecycle.lastTransitionAt,
    transcriptKind: session.transcriptRef?.kind ?? null,
    transcriptPath: session.transcriptRef?.path ?? null,
    agentChatId: session.agentChatId ?? null,
    modelOverride: session.modelOverride ?? null,
    pinnedAt: session.pinnedAt ?? null,
    initialPrompt: session.initialPrompt ?? null,
    archivedAt: session.archivedAt ?? null,
    handoffSummary: session.handoffSummary ?? null,
    spawnedFrom: session.spawnedFrom ?? null,
    supersededBy: session.supersededBy ?? null,
    prState: session.pr?.state ?? null,
    prNumber: session.pr?.number ?? null,
    prUrl: session.pr?.url ?? null,
    prCheckedAt: session.pr?.checkedAt ?? null,
    prBranch: session.pr?.prBranch ?? null,
  };
}

export interface WorktreeRow {
  id: string;
  projectId: string;
  name: string | null;
  branch: string;
  baseBranch: string | null;
  baseSha: string | null;
  createdAt: string;
  pinnedAt: string | null;
  sortOrder: number;
  terminalSeq: number;
  agentSeq: number;
  branchIsPlaceholder: number;
}

export function rowToWorktree(row: WorktreeRow, sessions: SessionRecord[]): WorktreeRecord {
  return {
    id: row.id,
    ...(row.name != null ? { name: row.name } : {}),
    branch: row.branch,
    ...(rowToBool(row.branchIsPlaceholder) ? { branchIsPlaceholder: true } : {}),
    baseBranch: row.baseBranch ?? "",
    baseSha: row.baseSha ?? "",
    createdAt: row.createdAt,
    ...(row.pinnedAt != null ? { pinnedAt: row.pinnedAt } : {}),
    sortOrder: row.sortOrder,
    terminalSeq: row.terminalSeq,
    agentSeq: row.agentSeq,
    sessions,
  };
}

export function worktreeToRow(w: WorktreeRecord, projectId: string): WorktreeRow {
  return {
    id: w.id,
    projectId,
    name: w.name ?? null,
    branch: w.branch,
    baseBranch: w.baseBranch ?? null,
    baseSha: w.baseSha ?? null,
    createdAt: w.createdAt,
    pinnedAt: w.pinnedAt ?? null,
    sortOrder: w.sortOrder ?? 0,
    terminalSeq: w.terminalSeq ?? 0,
    agentSeq: w.agentSeq ?? 0,
    branchIsPlaceholder: boolToRow(w.branchIsPlaceholder),
  };
}

export interface ProjectRow {
  id: string;
  absolutePath: string;
  prefix: string;
  isGit: number;
  defaultBranch: string | null;
  createdAt: string;
  hidden: number;
  directSessionSeq: number;
  nextWorktreeNum: number;
}

export function rowToProject(
  row: ProjectRow,
  worktrees: WorktreeRecord[],
  directSessions: SessionRecord[],
): ProjectRecord {
  return {
    id: row.id,
    absolutePath: row.absolutePath,
    prefix: row.prefix,
    isGit: rowToBool(row.isGit),
    ...(row.defaultBranch != null ? { defaultBranch: row.defaultBranch } : {}),
    createdAt: row.createdAt,
    ...(rowToBool(row.hidden) ? { hidden: true } : {}),
    directSessions,
    directSessionSeq: row.directSessionSeq,
    worktrees,
    nextWorktreeNum: row.nextWorktreeNum,
  };
}

export function projectToRow(p: ProjectRecord): ProjectRow {
  return {
    id: p.id,
    absolutePath: p.absolutePath,
    prefix: p.prefix,
    isGit: boolToRow(p.isGit),
    defaultBranch: p.defaultBranch ?? null,
    createdAt: p.createdAt,
    hidden: boolToRow(p.hidden),
    directSessionSeq: p.directSessionSeq ?? 0,
    nextWorktreeNum: p.nextWorktreeNum ?? 1,
  };
}
