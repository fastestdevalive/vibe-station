/**
 * Core domain types for the viberun-ide daemon.
 * These mirror the manifest.json schema from HIGH-LEVEL-DESIGN.md §2.
 */

export type CliId = "claude" | "cursor" | "opencode";

export type LifecycleState = "not_started" | "working" | "idle" | "done" | "exited";

export interface SessionLifecycle {
  state: LifecycleState;
  reason?: string;
  lastTransitionAt: string; // ISO8601
}

export type SessionSlot = "m" | `a${number}` | `t${number}`;
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
  tmuxName: string;
  lifecycle: SessionLifecycle;
  transcriptRef?: TranscriptRef;
}

export interface WorktreeRecord {
  id: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  createdAt: string; // ISO8601
  sessions: SessionRecord[];
}

export interface ProjectRecord {
  id: string;
  absolutePath: string;
  prefix: string;
  defaultBranch: string;
  createdAt: string; // ISO8601
  worktrees: WorktreeRecord[];
}
