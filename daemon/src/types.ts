/**
 * Core domain types for the vibe-station daemon.
 * These mirror the manifest.json schema from HIGH-LEVEL-DESIGN.md §2.
 */

export type { CliId } from "./agent-plugins/registry.js";

export type LifecycleState = "not_started" | "working" | "idle" | "done" | "exited";

export interface SessionLifecycle {
  state: LifecycleState;
  reason?: string;
  lastTransitionAt: string; // ISO8601
}

export type SessionSlot = "m" | `a${number}` | `t${number}` | `d${number}`;
export type SessionType = "agent" | "terminal";

export interface TranscriptRef {
  kind: "claude-jsonl" | "opencode-session" | "none";
  path?: string;
}

export interface SessionRecord {
  id: string;
  slot: SessionSlot;
  type: SessionType;
  modeId?: string;
  /**
   * User-facing display name. Currently set for terminals (defaults to
   * "Terminal N" from the worktree's monotonic counter, or a custom name).
   * Mutable — a rename endpoint can update it. When absent the UI falls back
   * to a slot-derived label.
   */
  name?: string;
  tmuxName: string;
  useTmux: boolean;
  lifecycle: SessionLifecycle;
  transcriptRef?: TranscriptRef;
  agentChatId?: string;
  /**
   * When set, this session is pinned to the top of its group in the sidebar.
   * Absent / undefined ≡ unpinned. The timestamp encodes recency order.
   * Currently surfaced for direct sessions via the sidebar actions menu.
   */
  pinnedAt?: string; // ISO8601
}

export interface WorktreeRecord {
  id: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  createdAt: string; // ISO8601
  /**
   * When set, this worktree is pinned to the top of the sidebar.
   * Absent / undefined ≡ unpinned. The timestamp also encodes recency order
   * (newest pinned first), so we don't need a separate sort field.
   */
  pinnedAt?: string; // ISO8601
  /**
   * Monotonic counter for default terminal names ("Terminal N"). Only ever
   * increments — numbers are never reused even after a terminal is deleted, so
   * names stay stable/unambiguous across a worktree's lifetime.
   */
  terminalSeq?: number;
  sessions: SessionRecord[];
}

export interface ProjectRecord {
  id: string;
  absolutePath: string;
  prefix: string;
  /**
   * Whether this project is a git repository. When false, worktrees cannot be
   * created — only direct sessions in the project directory. Set at project
   * creation time based on `isGitRepo()` check.
   */
  isGit: boolean;
  /**
   * Default branch for git projects (e.g., "main", "master"). Only present
   * when `isGit` is true. Used as the default base branch for new worktrees.
   */
  defaultBranch?: string;
  createdAt: string; // ISO8601
  /**
   * When true, the project (and all its worktrees) is hidden from the sidebar
   * and dashboard. Absent / undefined ≡ visible. Visibility-only — never
   * affects sessions, worktrees, or files. Unhide via Settings.
   */
  hidden?: boolean;
  /**
   * Sessions that run directly in the project directory without a worktree.
   * Available for all projects (git and non-git). These sessions edit files
   * in-place without branch isolation.
   */
  directSessions: SessionRecord[];
  /**
   * Monotonic counter for direct session slots (d1, d2, …). Only ever
   * increments — numbers are never reused even after a session is deleted.
   */
  directSessionSeq?: number;
  worktrees: WorktreeRecord[];
}
