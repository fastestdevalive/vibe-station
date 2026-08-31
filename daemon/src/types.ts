/**
 * Core domain types for the vibe-station daemon.
 * These mirror the manifest.json schema from HIGH-LEVEL-DESIGN.md §2.
 */

export type { CliId } from "./agent-plugins/registry.js";

export type LifecycleState =
  | "not_started"
  | "working"
  | "idle"
  | "waiting_for_human"
  | "done"
  | "exited";

export interface SessionLifecycle {
  state: LifecycleState;
  reason?: string;
  lastTransitionAt: string; // ISO8601
}

/**
 * VCS outcome axis for a session's branch — orthogonal to `LifecycleState`
 * (agent-activity axis). Written exclusively by `prPoller.ts` (see its module
 * doc); nothing else ever mutates `SessionRecord.pr`.
 */
export interface PrStatus {
  state: "none" | "draft" | "open" | "merged" | "closed";
  /** Present iff a PR exists (i.e. `state !== "none"`). */
  number?: number;
  /** Present iff a PR exists (i.e. `state !== "none"`). */
  url?: string;
  /** ISO8601 — when this status was last (successfully or not) checked. */
  checkedAt: string;
  /** Set on `no_credentials`/`error` results; `state` is held, not guessed (R4). */
  error?: string;
  /**
   * The branch `prPoller.ts` queried GitHub for when it produced this status
   * (D20). The UI only renders the PR colour when this matches the
   * worktree's CURRENT branch (`worktreePrStatus`) — otherwise a branch
   * switch would show a stale PR colour until the next 10s poll tick.
   */
  prBranch?: string;
}

export type SessionType = "agent" | "terminal";

/** How a session's `name` was set — informational/UI only (F1). */
export type SessionNameSource = "auto" | "user";

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
  | "status"
  | "mode_update"
  | "commands_update";

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
 * Normalized non-text (or text-in-a-mixed-array) content block, carried in
 * `NormalizedEvent.blocks` (acp-normalize-superset, Gap 1). `type:"text"`
 * blocks are a redundant copy of `NormalizedEvent.text` — kept for order,
 * never the only place text lives.
 */
export interface NormalizedContentBlock {
  type: "text" | "image" | "audio" | "resource" | "resource_link";
  /** `type:"text"` only */
  text?: string;
  /** `type:"image"|"audio"|"resource_link"` */
  mimeType?: string;
  /** base64, `type:"image"|"audio"` only */
  data?: string;
  /** `type:"resource_link"`, or `type:"resource"`'s nested `resource.uri` */
  uri?: string;
  /** `type:"resource_link"` only */
  name?: string;
}

/** A structured file-edit diff from a `ToolCallContent` entry (Gap 2). */
export interface ToolDiff {
  /** absolute file path */
  path: string;
  /** absent ⇒ new file */
  oldText?: string;
  newText: string;
}

/** ACP `ToolKind` union, verbatim (Gap 4). */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

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
  /** Non-text (or mixed) content blocks from `agent_message_chunk`/`agent_thought_chunk` (Gap 1). */
  blocks?: NormalizedContentBlock[];
  /** Structured file-edit diffs from `tool_call`/`tool_call_update.content` (Gap 2). */
  toolDiffs?: ToolDiff[];
  /** `tool_call`/`tool_call_update.locations` (Gap 3). */
  toolLocations?: { path: string; line?: number }[];
  /** `tool_call`/`tool_call_update.kind`, structural (Gap 4). */
  toolKind?: AcpToolKind;
  /** ACP `ToolCallStatus`, mirrored on `tool_use`/`tool_result` events (Gap 5). */
  toolStatus?: "pending" | "in_progress" | "completed" | "failed";
  /** `mode_update` only — the new `currentModeId` (Gap 6). */
  modeId?: string;
  /** `commands_update` only — the available slash commands (Gap 7). */
  commands?: { name: string; description: string }[];
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
  /**
   * Worktree this session belongs to. `undefined`/absent for a direct
   * (project-scoped, no-worktree) session. Replaces one of `slot`'s three
   * former jobs (identity is now `id`; scope is now this field).
   */
  worktreeId?: string;
  /** Owning project — always present, mirrors the project this session's worktree (if any) belongs to. */
  projectId: string;
  /**
   * True for the single main agent session of a worktree. Replaces
   * `slot === "m"`. Always false for direct sessions and for terminals.
   */
  isMain: boolean;
  /** Fractional display-order rank within its scope (worktree, or project's direct sessions). Reordering UI is Part 03 — this part only ever assigns a monotonically increasing value at creation. */
  sortOrder: number;
  type: SessionType;
  modeId?: string;
  /**
   * User-facing display name. Set at creation (heuristic slug from the
   * prompt, or a default like "Terminal N"/"Agent N"). Mutable via the
   * rename endpoint. When absent the UI computes a default display label
   * itself (see `sessionLabel()` in web-ui/src/lib/sessionLabel.ts).
   */
  name?: string;
  /** How `name` was set — heuristic at creation vs. an explicit user rename. Informational/UI only. */
  nameSource?: SessionNameSource;
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
  /**
   * Identity #1 of two (see the "two session identities" block above
   * `AgentPlugin.captureNativeChatId` in `services/spawn.ts`): the **NATIVE**
   * chat id — the value this CLI's OWN `--resume`/`--session`/`--conversation`
   * flag and native transcript store understand. Invariant: this field is
   * ALWAYS the native id, never an ACP-protocol one. It is what the Terminal
   * channel resumes with, and for a CLI whose two ids coincide (claude,
   * opencode) it doubles as the ACP id too.
   */
  agentChatId?: string;
  /**
   * Identity #2 of two. ACP migration (Decision 6 Option B only). The ACP `session/new`/`load` id
   * for a plugin whose spike proved this differs from the CLI's own native
   * resume id — read ONLY by `session/load` reconnect (Decision 5). Plugins
   * whose spike proved the two ids coincide (Option A) never set this; for
   * them `agentChatId` alone is both the ACP id and the native id.
   */
  acpSessionId?: string;
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
  /**
   * The user's original create-dialog task prompt. Kept so `POST
   * /sessions/:id/resume` can re-deliver it when a resume falls back to a
   * fresh launch (no `agentChatId` was ever captured, i.e. the session never
   * actually established a conversation — see spawn.ts's `composeLaunchPrompt`
   * plugins, which only inject a task prompt when one is passed in). Consumed
   * only while `agentChatId` is absent, and cleared once the session is marked
   * done, so a session that DID run never silently replays its first prompt.
   */
  initialPrompt?: string;
  /**
   * Set when this session was retired by `POST /sessions/:id/reset` (Decision
   * 2/9). An archived session is read-only history — its runtime is released
   * and it is never resumed; the reset always creates a NEW session row to
   * continue in. Absent ≡ live/normal session.
   */
  archivedAt?: string; // ISO8601
  /**
   * Handoff summary for a retired session — either delivered directly via
   * `--handoff-file` (the CLI reads the agent's own file and sends its
   * contents as `handoffText`, no daemon-side file lookup) or, for the
   * UI-driven "Reset with handoff" case, produced by a bounded paste+poll
   * turn against a one-off `/tmp` path. Only ever set on an archived row.
   * `null`/absent when no handoff was requested or it timed out.
   */
  handoffSummary?: string | null;
  /**
   * SessionId this session was spawned from — set from `sourceAgentId` in the
   * create request body (in-app dialogs, or a running agent's own shell via
   * `vst ... --source-agent`), or absent/null when created with no source
   * (the common case today: Out of Scope this round for the in-app dialogs,
   * which have no source-agent picker UI yet). Write-once: set at creation,
   * never mutated afterward (agent-interaction-workspaces/04-workspaces
   * Phase 4a, Decision 7). No FK enforcement — a deleted source session
   * leaving a dangling id is harmless (the web-ui's workspace-tile scan
   * simply finds no match, S5).
   */
  spawnedFrom?: string | null;
  /**
   * Set once a reset (`/vst reset --handoff`) archives this session — the
   * replacement session's id. Distinct from `archivedAt` (`/done` also sets
   * that; only a reset sets this). No FK enforcement — same rationale as
   * `spawnedFrom` above.
   */
  supersededBy?: string | null;
  /**
   * VCS status for this session's branch, written only by `prPoller.ts`.
   * Absent ≡ never checked (e.g. session just created, or its worktree has
   * no GitHub remote).
   */
  pr?: PrStatus;
}

export interface WorktreeRecord {
  id: string;
  /** Cosmetic display name (F2). `NULL`/absent falls back to `branch`. Never touches the git branch or on-disk directory. */
  name?: string;
  branch: string;
  /**
   * True when `branch` was auto-generated as a `wip/<wtId>` placeholder
   * because creation supplied neither an explicit branch nor a prompt to
   * derive one from (or the prompt-derived slug was empty/collided). There is
   * deliberately no mechanism to rename this later short of the user running
   * `git branch -m` themselves — see the branch-name-optional design notes.
   * Absent/false for every worktree whose branch came from explicit input or
   * a successful prompt-derived slug.
   */
  branchIsPlaceholder?: boolean;
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
   * When set, this worktree is hidden from the sidebar (both the normal list
   * and the pinned section) and surfaces only in the project's "Hidden
   * worktrees" list. Absent ≡ visible. Hiding a pinned worktree clears
   * `pinnedAt` in the same update — unhiding does not restore the pin.
   */
  hiddenAt?: string; // ISO8601
  /** Fractional display-order rank among a project's worktrees (F9 — reordering itself is Part 03). */
  sortOrder: number;
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
