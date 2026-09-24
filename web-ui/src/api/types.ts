/** Mirrors docs/HIGH-LEVEL-DESIGN.md §8 */

export interface TunnelState {
  enabled: boolean;
  tunnelUrl: string | null;
  /** Epoch ms when the current tunnel process was started, or null. */
  startedAt?: number | null;
}

export interface MobileQrResponse {
  qrUrl: string;
  expiresAt: number;
}

export interface LocalQrResponse {
  qrUrl: string;
  expiresAt: number;
  connectionType: "tailscale" | "lan";
}

/** Mirrors daemon `TailscaleStatus` (services/tailscaleServe.ts). */
export type TailscaleStatus =
  | { state: "not_installed" }
  | { state: "starting" }
  | { state: "not_connected" }
  | { state: "needs_operator"; fixCommand: string }
  | { state: "certs_not_enabled"; dnsName: string }
  | { state: "connected_no_serve"; httpsUrl: string; setupCommand: string }
  | { state: "serve_active"; httpsUrl: string }
  | { state: "port_mismatch"; expectedPort: number; actualPort: number; fixCommand: string }
  | { state: "error"; message: string };

/** Response from GET /tailscale/qr — same shape as local/tunnel QR responses. */
export interface TailscaleQrResponse {
  qrUrl: string;
  expiresAt: number;
}

/** Response from POST /tailscale/serve/enable. */
export interface EnableTailscaleResponse {
  httpsUrl: string;
  enabled: boolean;
}

/** Response from POST /tailscale/up (tailscaleServe.runUp). */
export interface TailscaleUpResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  loginUrl: string | null;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  port: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  prefix: string;
  /** True if this is a git repository; false for non-git directories. */
  isGit: boolean;
  /** Default branch (git projects only). */
  defaultBranch?: string;
  createdAt: string;
  /** When true, the project and all its worktrees are hidden from the sidebar
   *  and dashboard. Always emitted by the daemon (defaults to false). */
  hidden: boolean;
}

export interface Worktree {
  id: string;
  projectId: string;
  /** Cosmetic display name (F2). Falls back to `branch` when null/absent. */
  name?: string | null;
  branch: string;
  baseBranch: string;
  baseSha?: string;
  createdAt: string;
  /**
   * ISO8601 timestamp set when the user pins this worktree to the top of the
   * sidebar; null when unpinned. The timestamp also encodes recency for
   * default sort order (newest first).
   */
  pinnedAt: string | null;
  /**
   * ISO8601 timestamp set when the user hides this worktree from the
   * sidebar; null when visible. Hidden worktrees surface only in the
   * project's "Hidden worktrees" list. Hiding clears `pinnedAt` server-side.
   */
  hiddenAt: string | null;
  /** Fractional display-order rank among a project's worktrees (F9). Optional for legacy/test fixtures predating this field. */
  sortOrder?: number;
  /**
   * Id of the worktree's main (isMain === true) agent session. Present on
   * create so the JSON create flow can upload + send its first turn to the
   * main agent. Null for legacy/edge records with no main session.
   */
  mainSessionId?: string | null;
}

/**
 * File-browsing scope. "worktree" hits /worktrees/:id/... (git-aware);
 * "project" hits /projects/:id/... (plain files in the project base dir, used
 * by direct sessions which have no worktree).
 */
export type FileScope = "worktree" | "project";

export type SessionType = "agent" | "terminal";

/**
 * `waiting_for_human` (idle-after-having-worked, R3) is wired up daemon-side
 * as of .vibekit/feature-plans/wip/agent-interaction-workspaces/03-interaction-states —
 * real `session:state` events carry this value, not just the dev-only
 * state-simulation panel (components/dev/DevStatePanel.tsx).
 *
 * PR outcome is a separate, orthogonal axis (`Session.pr`, see `PrStatus`
 * below) — it is no longer folded into this lifecycle union. See
 * .vibekit/feature-plans/wip/pr-status-axis for the split.
 */
export type SessionState =
  | "not_started"
  | "working"
  | "idle"
  | "waiting_for_human"
  | "done"
  | "exited"
  | "drafting";

/**
 * Execution channel (mirror of daemon `Channel`). `json` = structured JSON
 * agent chat (ChatPane) instead of a TTY (TerminalPane).
 */
export type Channel = "tmux" | "pty" | "json";

export interface Session {
  id: string;
  /** Worktree this session belongs to; null for direct sessions. */
  worktreeId: string | null;
  /** Project this session belongs to. null for global drafts (no project chosen yet). */
  projectId: string | null;
  modeId: string | null;
  type: SessionType;
  /** User-set display name. null/absent when using the computed default label
   *  — see `sessionLabel()` in `@/lib/sessionLabel`, which every renderer
   *  calls instead of a stored `label` field (removed: it duplicated `name`
   *  and could go stale independently of it). */
  name?: string | null;
  /** True for a worktree's single main agent session (non-closable). Replaces the old `slot === "m"` check. */
  isMain: boolean;
  state: SessionState;
  lifecycleState: SessionState;
  tmuxName: string;
  useTmux?: boolean;
  /** Execution channel; absent on legacy rows (treat as tmux/pty). */
  channel?: Channel;
  createdAt: string;
  /** When set, the session is pinned to the top of its sidebar group. */
  pinnedAt?: string | null;
  /** Fractional display-order rank within its scope (worktree, or project's direct sessions). Optional for legacy/test fixtures predating this field. */
  sortOrder?: number;
  /** How `name` was set — "auto" (heuristic) vs. "user" (explicit rename). Informational/UI only. */
  nameSource?: "auto" | "user" | null;
  /** Set once a reset (POST .../reset) archives this session; null/absent ≡ live/normal session. */
  archivedAt?: string | null;
  /** Handoff summary written during a `reset --handoff`. Only ever set on an archived row. */
  handoffSummary?: string | null;
  /** SessionId this session was spawned from, or null (agent-interaction-
   *  workspaces/04-workspaces Phase 4). Write-once, set at creation. */
  parentSessionId?: string | null;
  /** Set once a reset archives this session — the replacement session's id.
   *  Distinct from `archivedAt` (`/done` also sets that; only a reset sets
   *  this). */
  supersededBy?: string | null;
  /** VCS outcome axis — orthogonal to `state`/`lifecycleState` (mirrors
   *  daemon `SessionRecord.pr`). Absent ≡ never checked (e.g. legacy/test
   *  fixtures); REST (`sessions.ts`'s `serializeSession`) always sends an
   *  explicit `null` when there's no PR yet, matching `parentSessionId`. */
  pr?: PrStatus | null;
  /** Raw draft prompt while the session is in the `"drafting"` lifecycle
   *  state. Cleared (null) once the draft is started. */
  draftPrompt?: string | null;
  /** Draft config while the session is `"drafting"` (see `DraftConfig`).
   *  Cleared (null) once the draft is started. */
  draftConfig?: DraftConfig | null;
}

/**
 * Config captured while a session is a draft (`state: "drafting"`), mirroring
 * the daemon `DraftConfig` (`daemon/src/types.ts`). `projectId` and
 * `worktreeId` are on the `SessionRecord`, not duplicated here.
 */
export interface DraftConfig {
  entryPoint: "worktree" | "direct" | "tab" | "global";
  modeId?: string;
  channel?: "tmux" | "pty" | "json";
  // worktree / global-with-worktree
  worktreeChoice?: "new" | "existing";
  existingWorktreeId?: string;
  branch?: string;
  baseBranch?: string;
  useTmux?: boolean;
  // global entry point
  useWorktree?: boolean;
}

/** Body for `POST /sessions` with `state: "drafting"` (create a draft).
 *  Exactly one of `projectId` / `worktreeId` must be present — expressed as a
 *  union so TypeScript rejects a body with neither (the shape that used to be
 *  silently stripped by the daemon's zod union and 400'd at runtime). */
export type CreateDraftSessionBody = {
  type: "agent";
  draftPrompt?: string;
  draftConfig: DraftConfig;
  state?: "drafting";
} & (
  | { target?: "direct"; projectId: string; worktreeId?: never }
  | { target?: "worktree"; worktreeId: string; projectId?: never }
  | { target: "global"; projectId?: never; worktreeId?: never }
);

/**
 * VCS outcome axis for a session's branch (mirror of daemon `PrStatus`,
 * `daemon/src/types.ts`) — orthogonal to `SessionState` (agent-activity
 * axis). Written exclusively by the daemon's PR poller.
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
   * The branch the daemon's `prPoller` queried GitHub for when it produced
   * this status (D20). `worktreePrStatus` only returns this status when it
   * matches the worktree's CURRENT branch — otherwise a branch switch would
   * show a stale PR colour until the next poll tick.
   */
  prBranch?: string;
}

/** Token / cost usage numbers (mirror of daemon `UsageInfo`). */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  contextWindow?: number;
  costUsd?: number;
  model: string;
}

/** A file attached to a user message (mirror of daemon `Attachment`). */
export interface Attachment {
  id: string;
  name: string;
  path: string;
  size: number;
  mime: string;
}

export type NormalizedEventProvider = "claude" | "cursor" | "opencode";

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
  | "commands_update"
  | "message_generated";

/** Normalized non-text (or text-in-a-mixed-array) content block (mirror of daemon `NormalizedContentBlock`). */
export interface NormalizedContentBlock {
  type: "text" | "image" | "audio" | "resource" | "resource_link";
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  name?: string;
}

/** A structured file-edit diff (mirror of daemon `ToolDiff`). */
export interface ToolDiff {
  path: string;
  oldText?: string;
  newText: string;
}

/** ACP `ToolKind` union, verbatim (mirror of daemon `AcpToolKind`). */
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

/** One normalized chat event (mirror of daemon `NormalizedEvent`). */
export interface NormalizedEvent {
  id: string;
  sessionId: string;
  ts: string;
  provider: NormalizedEventProvider;
  kind: NormalizedEventKind;
  role?: "user" | "assistant";
  text?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: unknown;
  toolResult?: { content?: string; isError?: boolean };
  usage?: UsageInfo;
  model?: string;
  turnId?: string;
  attachments?: Attachment[];
  /** Marks a superseding `user` event from editing a queued turn (last wins). */
  edited?: boolean;
  /** Marks a superseding `user` event for a queued turn cancelled before it ran —
   *  kept in history but never processed by the agent (last wins). */
  cancelled?: boolean;
  /** True when this event was truncated away by a fork (R3.4) — filtered on render
   *  as a client-side guard; the daemon already excludes superseded rows from replay. */
  superseded?: boolean;
  agentChatId?: string;
  /** Durable monotonic pagination cursor assigned by the daemon at persist. */
  logSeq?: number;
  /** Non-text (or mixed) content blocks from `agent_message_chunk`/`agent_thought_chunk`. */
  blocks?: NormalizedContentBlock[];
  /** Structured file-edit diffs from `tool_call`/`tool_call_update.content`. */
  toolDiffs?: ToolDiff[];
  /** `tool_call`/`tool_call_update.locations`. */
  toolLocations?: { path: string; line?: number }[];
  /** `tool_call`/`tool_call_update.kind`, structural. */
  toolKind?: AcpToolKind;
  /** ACP `ToolCallStatus`, mirrored on `tool_use`/`tool_result` events. */
  toolStatus?: "pending" | "in_progress" | "completed" | "failed";
  /** `mode_update` only — the new `currentModeId`. */
  modeId?: string;
  /** `commands_update` only — the available slash commands. */
  commands?: Command[];
  /** `message_generated` only — the child session that changed state. */
  subagentId?: string;
  /** `message_generated` only — display name of the child session. */
  subagentName?: string;
  /** `message_generated` only — lifecycle state the child transitioned to. */
  subagentState?: string;
  /** True when this is a daemon-synthesized notice turn (subagent-ux-v2) — UI must not render as a human bubble. */
  silent?: boolean;
}

/** A slash command/skill catalog entry (`commands_update`, session meta). */
export interface Command {
  name: string;
  description: string;
  argumentHint?: string;
}

export type TurnState = "idle" | "queued" | "thinking" | "responding" | "tool" | "error";

/** Response from POST /sessions/:id/chat (202). */
export interface SendChatResponse {
  turnId: string;
  queuePosition: number;
  delivery?: "queued" | "steered";
}

/** Response from POST /sessions/:id/chat/queue/:turnId/edit (queue-controls). */
export interface BeginEditResponse {
  turnId: string;
  /** Raw user text to prefill the inline editor. */
  message: string;
  /** Full attachment records to restore as chips in the editor. */
  attachments: Attachment[];
  /** Original queue index (informational). */
  queueIndex: number;
}

/** Response from POST /sessions/:id/attachments (201). */
export interface UploadAttachmentsResponse {
  attachments: Attachment[];
}

/** Response from GET /sessions/:id/transcript (full or `since` delta). */
export interface TranscriptResponse {
  events: NormalizedEvent[];
}

/**
 * A bounded transcript window + keyset cursor (tail-N or `beforeSeq` page).
 * `oldestSeq` is the `logSeq` of the first event; `hasMore` is true when older
 * rows exist before it (R2.1/R2.2).
 */
export interface TranscriptPage {
  events: NormalizedEvent[];
  oldestSeq?: number;
  hasMore: boolean;
}

/** Cross-harness session meta feeding the status bar (mirror of daemon `SessionMeta`). */
export interface SessionMeta {
  sessionId: string;
  channel: Channel;
  modeId?: string;
  modeName?: string;
  cli: CliId;
  model?: string;
  turnState: TurnState;
  queueDepth: number;
  /** Runnable queued turnIds in FIFO order (per-turn badge + affordances). */
  queuedTurnIds: string[];
  /** turnIds withdrawn into the editing hold (drives the "editing" bubble). */
  editingTurnIds: string[];
  usage?: UsageInfo;
  /** Absolute working directory for the session (worktree or project root). */
  cwd?: string;
  /** True when the connection supports mid-turn steering (`_session/steering`). */
  canSteer?: boolean;
  /** Latest `commands_update` catalog for this session, if any (full-replace). */
  commands?: Command[];
  /** Populated while a notice slot is pending or running (subagent-ux-v2).
   *  `running: true` while the notice LLM turn is active. */
  noticeSlot?: { children: Record<string, string>; running: boolean };
  /** The currently active turn id, if any. */
  activeTurnId?: string;
}

/** Dynamic CLI id strings — canonical list from GET /supported-clis */
export type CliId = string;

export interface SupportedCli {
  id: string;
  defaultModel: string;
  /** Whether this CLI can run the JSON agent-chat channel. */
  supportsJson: boolean;
  /**
   * Whether this CLI ships a native-history importer — i.e. a terminal→JSON
   * switch can backfill the terminal-phase turns into the JSON view. When
   * false (cursor/agy), the toggle still works but returns lossily: those turns
   * won't appear in JSON chat, though the agent still has them via --resume.
   */
  importsNativeHistory: boolean;
  /**
   * Whether a Rich Chat session for this CLI can actually resume its
   * conversation when toggled to the Terminal channel. `false` (cursor) means
   * the toggle still works but always starts a fresh terminal conversation —
   * the CLI's ACP session state lives somewhere its own `--resume` can't reach.
   */
  supportsJsonToTerminalResume: boolean;
}

export interface Mode {
  id: string;
  name: string;
  cli: CliId;
  context: string;
  presetId?: string;
  /** Passed as CLI `--model` / `-m` when set; omitted uses CLI default. */
  model?: string;
  /** Key into the mode-icon asset set (claude|agy|opencode|deepseek|cursor); absent → generic fallback. */
  icon?: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

export interface SearchMatch {
  line: number;
  pre: string;
  mid: string;
  post: string;
}

export interface SearchFileMatches {
  path: string;
  matches: SearchMatch[];
}

export interface SearchResult {
  files: SearchFileMatches[];
  truncated: boolean;
  totalMatches: number;
}

export interface FileSearchResult {
  files: string[];
  truncated: boolean;
}

export interface GutterResult {
  added: number[];
  deleted: number[];
  modified: number[];
}

export type WSEvent =
  | {
      type: "session:created";
      sessionId: string;
      /** Null for direct sessions (no worktree). */
      worktreeId: string | null;
      /** Project ID (present for direct sessions); null for global drafts. */
      projectId?: string | null;
      sessionType: SessionType;
      /** Legacy: mode id string when agent; omitted for terminal */
      mode?: string;
      /** Full session row for optimistic UI (daemon v1+) */
      snapshot?: Session;
      /** SessionId this session was spawned from, or null (agent-interaction-
       *  workspaces/04-workspaces Phase 4b). Absent ≡ pre-upgrade daemon —
       *  treat identically to null (skip the auto-insert scan, Phase 4c). */
      parentSessionId?: string | null;
    }
  | {
      type: "session:state";
      sessionId: string;
      state: SessionState;
      reason?: string;
    }
  | {
      type: "session:opened";
      sessionId: string;
    }
  | {
      type: "session:output";
      sessionId: string;
      chunk: string;
    }
  | {
      type: "session:exited";
      sessionId: string;
      exitCode?: number;
    }
  | {
      type: "session:deleted";
      sessionId: string;
    }
  | {
      type: "session:updated";
      sessionId: string;
      pinnedAt?: string | null;
      /** New execution channel after a live JSON↔terminal toggle (P3, R1.7). */
      channel?: Channel;
      /** After a rename (PATCH .../rename) — `null` means cleared back to the
       *  computed default label. Patching this is sufficient: every renderer
       *  computes the display label from `name` via `sessionLabel()`, so
       *  there is no separate `label` field that needs its own patch. */
      name?: string | null;
      /** Set once a reset (POST .../reset) archives this session. */
      archivedAt?: string | null;
      /** After a reorder (PATCH .../reorder) — the session's new fractional display-order rank. */
      sortOrder?: number;
      /** After a `prPoller.ts` tick updates this session's VCS status (pr-status-axis). */
      pr?: PrStatus | null;
      /** Set on the archived session by a reset — the replacement session's id. */
      supersededBy?: string | null;
      /** Set true when a main-session promotion (DELETE /sessions/:id on the
       *  old main) flips this session to the worktree's new main. */
      isMain?: boolean;
      /** Cleared to null by PATCH /sessions/:id/delink; absent means unchanged. */
      parentSessionId?: string | null;
      /** Set on draft-promotion (draft→real worktree session, POST .../start):
       *  the worktree this drafting session was promoted into. */
      worktreeId?: string;
      /** Set on draft updates (PATCH .../draft): the raw draft prompt. */
      draftPrompt?: string | null;
      /** Set on draft updates (PATCH .../draft): the draft config. */
      draftConfig?: DraftConfig | null;
    }
  | {
      type: "session:error";
      sessionId: string;
      message: string;
      /**
       * Machine-readable classification. Branch on this — never regex-match
       * `message`. "gone" = session genuinely absent; "transient" = attach or
       * stream hiccup, the session may still be alive. Optional for
       * compatibility with a daemon older than this field.
       */
      reason?: "gone" | "transient";
    }
  | {
      type: "session:resumed";
      sessionId: string;
      restoredFromHistory: boolean;
    }
  | {
      /** JSON agent chat: bounded tail-N replay on chat:open (or a `sinceSeq`
       *  delta, in which case the cursor fields are omitted). */
      type: "chat:replay";
      sessionId: string;
      events: NormalizedEvent[];
      /** `logSeq` of the oldest replayed event (keyset cursor for load-earlier). */
      oldestSeq?: number;
      /** True when older rows exist before `oldestSeq`. */
      hasMore?: boolean;
      /** Forward-pagination cursor (socket-cycling fix): `logSeq` of the LAST
       *  event in `events`, set on a bounded `sinceSeq` delta replay. The client
       *  passes it back as the next `sinceSeq` while `hasMore` is true. */
      nextSeq?: number;
    }
  | {
      /** JSON agent chat: one live normalized event. */
      type: "session:message";
      sessionId: string;
      event: NormalizedEvent;
    }
  | {
      /** JSON agent chat: usage/model/turn-state update. */
      type: "session:meta";
      sessionId: string;
      meta: SessionMeta;
    }
  | {
      /** JSON agent chat: an edit-a-sent-message fork truncated these turns —
       *  other tabs drop the superseded bubbles and re-sync (P4/R3.6). */
      type: "session:fork";
      sessionId: string;
      supersededTurnIds: string[];
    }
  | {
      type: "file:open";
      worktreeId: string;
      path: string;
    }
  | {
      type: "file:changed";
      worktreeId: string;
      path: string;
    }
  | {
      type: "file:deleted";
      worktreeId: string;
      path: string;
    }
  | {
      type: "tree:changed";
      worktreeId: string;
      path: string;
      kind: "added" | "deleted" | "renamed";
      from?: string;
      to?: string;
    }
  | {
      type: "project:created";
      project: Project;
    }
  | {
      type: "project:deleted";
      projectId: string;
    }
  | {
      type: "project:updated";
      project: Project;
    }
  | {
      type: "worktree:created";
      worktree: Worktree;
    }
  | {
      type: "worktree:deleted";
      worktreeId: string;
    }
  | {
      type: "worktree:updated";
      worktree: Worktree;
    }
  | {
      /** Broadcast after PUT /user/ordered-lists/:scopeKey (pinned-order-sync).
       *  `scopeKey` is generic even though only "pinned-all" is wired up today. */
      type: "orderedList:updated";
      scopeKey: string;
      itemIds: string[];
      updatedAt: string;
    }
  | {
      type: "mode:created";
      mode: Mode;
    }
  | {
      type: "mode:updated";
      mode: Mode;
    }
  | {
      type: "mode:deleted";
      modeId: string;
    }
  | {
      /** Broadcast after a successful `PATCH /settings` (themes/markdown —
       *  narrow payload, never the full `Settings` struct, which carries
       *  tokens). `themeId`/`markdownStyle` are the same camelCase wire shape
       *  as `GET /settings`. Either field may be absent (unchanged). */
      type: "settings:updated";
      themeId?: string;
      markdownStyle?: MarkdownStyle;
    }
  | {
      type: "pong";
    }
  | {
      /** Synthetic event emitted from the client on initial connect and every
       *  reconnect. Consumers use this to refetch server state — the client's
       *  persisted live caches (e.g. sessionStates) survive cold loads and can
       *  be stale, so we trust the server on every fresh handshake. */
      type: "ws:open";
    }
  | {
      type: "system:error";
      message: string;
    }
  | {
      type: "remote:connected";
      session: { tokenId: string; scope: string; connections: number; issuedAt: number; lastSeenAt: number; expiresAt?: number; deviceName?: string };
    }
  | {
      type: "remote:disconnected";
      tokenId: string;
      connections: number;
    }
  | {
      /** Sent by POST /open — navigate the UI to this project. */
      type: "navigate";
      projectId: string;
    };

export interface AuthSession {
  tokenId: string;
  scope: string;
  connections: number;
  issuedAt: number;
  lastSeenAt: number;
  expiresAt?: number;
  deviceName?: string;
}

export type DiffScope = "local" | "branch" | "none" | "commit";

/** Aggregate insertions/deletions against the worktree's base branch — see
 *  `GET /worktrees/:id/diffstat`. */
export interface DiffStat {
  insertions: number;
  deletions: number;
}

export type GitStatusChar = "M" | "A" | "D" | "R" | "?";

export interface ChangedPathEntry {
  path: string;
  status: GitStatusChar;
  /** Per-file line counts against the compared baseline. Undefined (both
   *  omitted together) for binary files, which have no meaningful line diff. */
  insertions?: number;
  deletions?: number;
  /** File mtime (ms since epoch). Only for `scope=local` entries that still
   *  exist on disk; absent for deleted files and other scopes. */
  mtimeMs?: number;
}

export interface CommitLogEntry {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601, author date. */
  date: string;
  subject: string;
  /** Full raw commit message (subject + body). Equal to `subject` when there's no body. */
  body: string;
  insertions: number;
  deletions: number;
  hasBinaryChanges: boolean;
  /**
   * True if this commit is unique to the worktree's branch (not already on
   * the base branch it forked from). False marks upstream/base-branch
   * history, which the VCS tool tab collapses by default.
   */
  isOnBranch: boolean;
}

/** One top-level `.gitmodules` submodule, joined with `git submodule
 *  status`'s pinned SHA/dirty-state — see `GET /worktrees/:id/submodules`. */
export interface SubmoduleInfo {
  path: string;
  sha: string | null;
  shortSha: string | null;
  branch: string | null;
  subject: string | null;
  status: "clean" | "modified" | "out-of-date" | "uninitialized";
}

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  author: string | null;
}

/** Mirrors daemon `PrLookupResult` (`daemon/src/services/github.ts`) — the
 *  body shape of `GET /worktrees/:id/pr`. A tagged union so "couldn't check"
 *  is never confused with "definitely no PR" (the bug this replaced). */
export type PrLookupResult =
  | { kind: "pr"; pr: PrInfo }
  | { kind: "no_pr" }
  | { kind: "not_github" }
  | { kind: "no_credentials" }
  | {
      kind: "error";
      reason: "network" | "rate_limited" | "auth" | "api";
      message: string;
      retryAfterMs?: number;
    };

export interface ProjectBranchesResponse {
  branches: string[];
  /** Null for a non-git project (the daemon sends null in that case). */
  defaultBranch: string | null;
}

export interface CreateWorktreeBody {
  projectId: string;
  /**
   * Optional (branch-name-optional). Omitted → the daemon derives a name
   * from `prompt`, or auto-generates a `wip/<worktree-id>` placeholder when
   * there's no prompt either.
   */
  branch?: string;
  modeId: string;
  baseBranch?: string;
  prompt?: string;
  useTmux?: boolean;
  /** `"json"` selects the JSON agent-chat channel for the main agent. */
  channel?: Channel;
  /**
   * JSON-channel callers that stage attachments before sending turn 1 (see
   * `sendJsonFirstTurn`) should still pass `prompt` here so the daemon can
   * derive the auto name / `initialPrompt` from it, but set this to `true`
   * so the daemon does NOT also auto-enqueue that prompt as turn 1 — the
   * caller sends it itself once attachments are uploaded. No-op outside the
   * JSON channel.
   */
  skipAutoTurn?: boolean;
}

export interface CreateSessionBody {
  worktreeId: string;
  modeId: string | null;
  type: SessionType;
  prompt?: string;
  useTmux?: boolean;
  /** `"json"` selects the JSON agent-chat channel. */
  channel?: Channel;
  /** Optional display name for terminals; blank → daemon assigns "Terminal N". */
  name?: string;
  /** See `CreateWorktreeBody.skipAutoTurn`. */
  skipAutoTurn?: boolean;
}

/** Body for creating a direct session (no worktree). */
export interface CreateDirectSessionBody {
  target: "direct";
  projectId: string;
  type: SessionType;
  modeId?: string;
  prompt?: string;
  useTmux?: boolean;
  /** `"json"` selects the JSON agent-chat channel. */
  channel?: Channel;
  name?: string;
  /** See `CreateWorktreeBody.skipAutoTurn`. */
  skipAutoTurn?: boolean;
}

/** Body for adding a new project. */
export interface AddProjectBody {
  path: string;
  name?: string;
  /** When true, run the git-ready setup script (init + .gitignore + initial
   *  `main` commit) against the directory after registering it. */
  setup?: boolean;
}

/** Response from POST /projects. Extends Project with an optional `warning`
 *  when `setup: true` was requested but the setup script failed (the project
 *  stays registered regardless — see daemon routes/projects.ts). */
export type AddProjectResponse = Project & { warning?: string };

export interface CreateModeBody {
  name: string;
  cli: CliId;
  context: string;
  presetId?: string;
  model?: string;
  /** Optional explicit icon key; when absent the daemon derives it from cli/model. */
  icon?: string;
}

export interface UpdateModeBody {
  name?: string;
  cli?: CliId;
  context?: string;
  model?: string;
  /** Optional explicit icon key; when absent the daemon re-derives it on cli/model change. */
  icon?: string;
}

export interface TerminalApi {
  openSession: (sessionId: string, cols: number, rows: number) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  sendKeystroke: (sessionId: string, data: string) => Promise<void>;
  resizeSession: (sessionId: string, cols: number, rows: number) => Promise<void>;
  /** Diagnostic channel (mobile double-text investigation): ship batched input/
   *  composition events to the daemon's input-debug log. Optional so the mock
   *  can omit it. */
  sendDebug?: (entries: Record<string, unknown>[]) => Promise<void>;
}

/**
 * Markdown per-element styling overrides (mirror of the Rust `MarkdownStyle`),
 * stored server-side in `~/.vibe-station/config.json`. Only overrides are
 * stored — an absent/empty value means "use the active theme's defaults".
 * Every field maps to a `--md-*` CSS custom property (see the Phase 2 theme
 * blocks and Phase 5's consumer).
 */
export interface MarkdownStyle {
  h1?: { size?: string; color?: string; weight?: number };
  h2?: { size?: string; color?: string; weight?: number };
  h3?: { size?: string; color?: string; weight?: number };
  h4?: { size?: string; color?: string; weight?: number };
  h5?: { size?: string; color?: string; weight?: number };
  h6?: { size?: string; color?: string; weight?: number };
  bold?: { weight?: number; color?: string };
  italic?: { style?: string; color?: string };
  inlineCode?: { bg?: string; color?: string };
  codeBlock?: { bg?: string; color?: string; border?: string };
  codeFontFamily?: string;
  blockquote?: { border?: string; color?: string };
  link?: { color?: string };
}

/** User-configurable settings from GET/PATCH /settings */
export interface Settings {
  defaultProjectsDir: string;
  /** Runtime-computed home dir (not persisted) — for `~` display/expansion. */
  homeDir?: string;
  /** Directories scanned for `<dir>/*\/SKILL.md` user skills (Decision 11). */
  skillPaths?: string[];
  /** Selected 14-way theme id (see `web-ui/src/theme/registry.ts`). Opaque
   *  string, not validated against the registry server-side. Absent → default
   *  `"vibestation-dark"`. */
  themeId?: string;
  /** Markdown per-element styling overrides (see `MarkdownStyle`). Absent →
   *  the active theme's defaults. */
  markdownStyle?: MarkdownStyle;
  /** Sticky content-search toggle state (Search tab) — persisted across sessions. */
  searchCaseSensitive?: boolean;
  searchRegex?: boolean;
  searchWholeWord?: boolean;
}

/** A directory-scanned skill catalog entry from GET /skills (Settings panel only). */
export interface Skill {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
}

/** Per-directory scan outcome from GET /skills. */
export interface SkillDirectory {
  path: string;
  skillCount: number;
  /** A real failure (permissions, I/O) — rendered as an error. */
  error?: string;
  /** Directory is absent. Normal for a shipped default whose CLI is not
   *  installed; rendered muted, never as an error. */
  missing?: boolean;
}

/** Response from GET /skills. */
export interface SkillsResponse {
  skills: Skill[];
  directories: SkillDirectory[];
}

/** Body for POST /projects/create — create a brand new project directory. */
export interface CreateProjectBody {
  /** Project name (directory name). */
  name: string;
  /** Parent directory override (default: settings.defaultProjectsDir). */
  dir?: string;
  /** Optional: start an agent after creating. */
  startAgent?: {
    modeId: string;
    prompt?: string;
    useWorktree?: boolean;
    /** Branch name for the worktree (useWorktree only). Default "feature". */
    branch?: string;
  };
}

/** Response from POST /projects/create. */
export interface CreateProjectResponse {
  project: Project;
  worktree?: Worktree;
  session?: Session;
  warning?: string;
}

/** Response from GET /fs/complete — directory-only autocomplete. */
export interface FsCompleteResponse {
  /** The directory being listed (absolute path). */
  base: string;
  /** Child directories matching the completion, sorted by name (capped). */
  entries: { name: string; path: string }[];
  /** True when the directory has more matching entries than were returned
   *  (i.e. `entries` was capped) — surfaced so a full-listing UI (the Browse
   *  dialog) can tell the user results are incomplete instead of silently
   *  omitting entries past the cap. */
  truncated: boolean;
}

/** Response from GET /fs/check — path inspection metadata. */
export interface FsCheckResponse {
  exists: boolean;
  isDirectory: boolean;
  isGit: boolean;
  /** Whether the repo's HEAD resolves to a commit. Only meaningful when
   *  `isGit` is true — null otherwise (not a repo, or path doesn't exist). */
  hasCommits: boolean | null;
}

export interface DeviceDiskInfo {
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  mountPoint: string;
}

export interface WorktreeDiskUsage {
  id: string;
  diskBytes: number;
}

export interface DiskUsageResponse {
  device: DeviceDiskInfo;
  worktrees: WorktreeDiskUsage[];
}
