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
  kind: "claude-jsonl" | "opencode-session" | "vst-json" | "none";
  path?: string;
}

/**
 * Execution channel for a session.
 * - `tmux` / `pty`: TTY-based agent/terminal (existing `useTmux` split).
 * - `json`: structured JSON agent chat — daemon spawns the CLI with
 *   `--output-format stream-json` per turn and streams NormalizedEvents.
 *
 * Derived default for legacy sessions with no `channel`: `useTmux ? "tmux" : "pty"`.
 */
export type Channel = "tmux" | "pty" | "json";

/** Provider (CLI harness) that produced a normalized event. */
export type NormalizedEventProvider = "claude" | "cursor" | "opencode" | "agy";

/**
 * Provider-agnostic chat event kind. Every JSON-channel plugin maps its CLI's
 * raw event stream into these. `user` + `status` are daemon-owned kinds
 * (Decision 12): the user's own message and transient turn-state signals.
 */
export type NormalizedEventKind =
  | "session_init"
  | "user"
  | "thinking"
  | "text"
  | "tool_use"
  | "tool_result"
  | "usage"
  | "result"
  | "error"
  | "status";

/** Token / cost usage numbers, normalized across harnesses. */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  /** When the harness reports the model's context window. */
  contextWindow?: number;
  /** When the harness reports per-turn/cumulative cost. */
  costUsd?: number;
  model: string;
}

/** A file attached to a user message, stored under sessionDataDir (Decision 5). */
export interface Attachment {
  /** uploadId */
  id: string;
  /** sanitized filename */
  name: string;
  /** absolute path, under sessionDataDir (NOT the checkout) */
  path: string;
  size: number;
  mime: string;
}

/**
 * One normalized chat event. This is the single shape the UI renders and the
 * transcript persists, regardless of which CLI produced it (Decision 3/4).
 */
export interface NormalizedEvent {
  id: string;
  sessionId: string;
  /** ISO8601, stamped by the daemon. */
  ts: string;
  provider: NormalizedEventProvider;
  kind: NormalizedEventKind;
  role?: "user" | "assistant";
  /** user | text | thinking | error */
  text?: string;
  /** tool_use */
  toolName?: string;
  /** tool_use | tool_result */
  toolId?: string;
  /** tool_use */
  toolInput?: unknown;
  toolResult?: { content?: string; isError?: boolean };
  /** usage | result */
  usage?: UsageInfo;
  model?: string;
  /** set on user + every event of that turn */
  turnId?: string;
  /**
   * Durable, per-session monotonic storage cursor assigned at `append` by the
   * TranscriptStore (R0.3). Drives pagination / `since` deltas / dedupe. Absent
   * on in-flight events before persistence and on legacy transcript lines (the
   * store synthesizes it from the row's `seq` on read).
   */
  logSeq?: number;
  /** on user events (echoed for replay) */
  attachments?: Attachment[];
  /**
   * Marks a superseding `user` event emitted when a queued turn is edited before
   * it runs (queue-controls). Replay keeps the LAST `user` per `turnId`.
   */
  edited?: boolean;
  /**
   * Marks a superseding `user` event emitted when a queued turn is cancelled
   * before it ran. The message stays in history (replay keeps the LAST `user`
   * per `turnId`) but is flagged as never processed by the agent, so the UI can
   * render it distinctly.
   */
  cancelled?: boolean;
  /**
   * Marks a row truncated by an edit-a-sent-message fork (R3.4). Distinct from
   * `edited` (queue-edit dedup): a fork HIDES the row. Stored as the `superseded`
   * DB column, not in the serialized payload — the store excludes these rows from
   * every read, so it is effectively never present on an event returned to callers.
   */
  superseded?: boolean;
  /**
   * Harness chat/session id, surfaced by the plugin on `session_init` so the
   * core can capture + persist it (Decision 10) without parsing raw CLI JSON.
   */
  agentChatId?: string;
}

/** Derived turn state driving the composer status indicator. */
export type TurnState = "idle" | "queued" | "thinking" | "responding" | "tool" | "error";

/**
 * Cross-harness session meta feeding the composer status bar (F8/F9).
 * Rebuilt from the transcript tail after a daemon restart.
 */
export interface SessionMeta {
  sessionId: string;
  channel: Channel;
  modeId?: string;
  modeName?: string;
  cli: string;
  model?: string;
  turnState: TurnState;
  /** pending turns behind the active one (= `queuedTurnIds.length`) */
  queueDepth: number;
  /**
   * Runnable queued turnIds in FIFO order (drives per-turn "queued" badge +
   * edit/send-now/cancel affordances). Held (editing) turns are NOT included.
   */
  queuedTurnIds: string[];
  /** turnIds withdrawn into the editing hold (drives the "editing" bubble state). */
  editingTurnIds: string[];
  usage?: UsageInfo;
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
  /**
   * Execution channel. NEW — absent on legacy manifests; derive via
   * `sessionChannel(session)` (defaults to `useTmux ? "tmux" : "pty"`).
   * `channel: "json"` forces `useTmux: false` (Decision 1/11).
   */
  channel?: Channel;
  lifecycle: SessionLifecycle;
  transcriptRef?: TranscriptRef;
  agentChatId?: string;
  /**
   * Per-session model override (JSON channel), set live from the status-bar model
   * switcher. When present it wins over the mode's model for every subsequent
   * turn's `--model` and is restart-durable. Absent ≡ use the mode's model /
   * CLI default. Never mutates the shared Mode.
   */
  modelOverride?: string;
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
  /**
   * Monotonic high-water counter for agent slots (a{n}). Only ever increments —
   * a deleted agent's number is never reused, so agent session ids
   * (`<worktree>-a{n}`) never recur across the worktree's lifetime.
   */
  agentSeq?: number;
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
  /**
   * Monotonic high-water mark for worktree numbers. Never decreases, never reused,
   * even after a worktree is deleted. Optional for back-compat with manifests
   * written before this field existed — `reserveNextWorktreeNum` lazily seeds it
   * from the existing worktrees the first time it's needed.
   */
  nextWorktreeNum?: number;
}
