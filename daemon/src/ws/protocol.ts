import { z } from "zod";

/**
 * Client-to-server messages.
 * Based on docs/API-CONTRACT.md WebSocket section.
 */

const SubscribeMessage = z.object({
  type: z.literal("subscribe"),
  sessionIds: z.array(z.string()),
});

const UnsubscribeMessage = z.object({
  type: z.literal("unsubscribe"),
  sessionIds: z.array(z.string()),
});

const SessionOpenMessage = z.object({
  type: z.literal("session:open"),
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const SessionInputMessage = z.object({
  type: z.literal("session:input"),
  sessionId: z.string(),
  data: z.string(),
});

const SessionResizeMessage = z.object({
  type: z.literal("session:resize"),
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const SessionCloseMessage = z.object({
  type: z.literal("session:close"),
  sessionId: z.string(),
});

const FileWatchMessage = z.object({
  type: z.literal("file:watch"),
  worktreeId: z.string(),
  path: z.string(),
});

const FileUnwatchMessage = z.object({
  type: z.literal("file:unwatch"),
  worktreeId: z.string(),
  path: z.string(),
});

const TreeWatchMessage = z.object({
  type: z.literal("tree:watch"),
  worktreeId: z.string(),
  path: z.string().optional(),
});

const TreeUnwatchMessage = z.object({
  type: z.literal("tree:unwatch"),
  worktreeId: z.string(),
  path: z.string().optional(),
});

const PingMessage = z.object({
  type: z.literal("ping"),
});

// JSON agent chat (Decision 6/12): subscribe to a session's normalized event
// stream. `chat:open` triggers a transcript replay; `chat:close` unsubscribes.
const ChatOpenMessage = z.object({
  type: z.literal("chat:open"),
  sessionId: z.string(),
  /** Reconnect delta cursor (R2.3): when set, the server replays only events
   *  strictly newer than this `logSeq` instead of a fresh tail snapshot. */
  sinceSeq: z.number().optional(),
});

const ChatCloseMessage = z.object({
  type: z.literal("chat:close"),
  sessionId: z.string(),
});

// Diagnostic channel (mobile double-text investigation): the client ships
// terminal input + IME/composition events here when ?debugInput=1 is enabled,
// and the daemon writes them to input-debug.log. Gated entirely on the client;
// when debugging is off, no debug:log messages are sent.
const DebugLogMessage = z.object({
  type: z.literal("debug:log"),
  entries: z.array(z.record(z.string(), z.unknown())),
});

export const ClientMessage = z.discriminatedUnion("type", [
  SubscribeMessage,
  UnsubscribeMessage,
  SessionOpenMessage,
  SessionInputMessage,
  SessionResizeMessage,
  SessionCloseMessage,
  FileWatchMessage,
  FileUnwatchMessage,
  TreeWatchMessage,
  TreeUnwatchMessage,
  PingMessage,
  ChatOpenMessage,
  ChatCloseMessage,
  DebugLogMessage,
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

/**
 * Normalized chat schemas (mirror of the TS types in daemon/src/types.ts).
 * Kept here so the WS layer can validate `session:message` / `session:meta`
 * / `chat:replay` payloads.
 */
export const UsageInfoSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreateTokens: z.number(),
  totalTokens: z.number(),
  contextWindow: z.number().optional(),
  costUsd: z.number().optional(),
  model: z.string(),
});

export const AttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  size: z.number(),
  mime: z.string(),
});

export const NormalizedEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  ts: z.string(),
  provider: z.enum(["claude", "cursor", "opencode", "agy"]),
  kind: z.enum([
    "session_init",
    "user",
    "thinking",
    "text",
    "tool_use",
    "tool_result",
    "usage",
    "result",
    "error",
    "status",
  ]),
  role: z.enum(["user", "assistant"]).optional(),
  text: z.string().optional(),
  toolName: z.string().optional(),
  toolId: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolResult: z
    .object({ content: z.string().optional(), isError: z.boolean().optional() })
    .optional(),
  usage: UsageInfoSchema.optional(),
  model: z.string().optional(),
  turnId: z.string().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  edited: z.boolean().optional(),
  agentChatId: z.string().optional(),
  /** Durable monotonic pagination cursor assigned at persist (R0.3/R2.x). */
  logSeq: z.number().optional(),
});

export const SessionMetaSchema = z.object({
  sessionId: z.string(),
  channel: z.enum(["tmux", "pty", "json"]),
  modeId: z.string().optional(),
  modeName: z.string().optional(),
  cli: z.string(),
  model: z.string().optional(),
  turnState: z.enum(["idle", "queued", "thinking", "responding", "tool", "error"]),
  queueDepth: z.number(),
  queuedTurnIds: z.array(z.string()),
  editingTurnIds: z.array(z.string()),
  usage: UsageInfoSchema.optional(),
});

/**
 * Server-to-client messages.
 * Based on docs/API-CONTRACT.md WebSocket section.
 */

// Per-session events (subscribers / open streams)
const SessionCreatedSnapshot = z.object({
  id: z.string(),
  worktreeId: z.string().nullable(),
  projectId: z.string().optional(),
  slot: z.string(),
  type: z.enum(["agent", "terminal"]),
  modeId: z.string().nullable(),
  label: z.string(),
  tmuxName: z.string(),
  useTmux: z.boolean().optional().default(true),
  channel: z.enum(["tmux", "pty", "json"]).optional(),
  state: z.enum(["not_started", "working", "idle", "done", "exited"]),
  lifecycleState: z.enum(["not_started", "working", "idle", "done", "exited"]),
  createdAt: z.string(),
});

const SessionCreatedEvent = z.object({
  type: z.literal("session:created"),
  sessionId: z.string(),
  worktreeId: z.string().nullable(),
  projectId: z.string().optional(), // for direct sessions
  sessionType: z.string(),
  mode: z.string().optional(),
  snapshot: SessionCreatedSnapshot.optional(),
});

const SessionStateEvent = z.object({
  type: z.literal("session:state"),
  sessionId: z.string(),
  state: z.enum(["not_started", "working", "idle", "done", "exited"]),
  reason: z.string().optional(),
});

const SessionOpenedEvent = z.object({
  type: z.literal("session:opened"),
  sessionId: z.string(),
});

const SessionOutputEvent = z.object({
  type: z.literal("session:output"),
  sessionId: z.string(),
  chunk: z.string(),
});

const SessionExitedEvent = z.object({
  type: z.literal("session:exited"),
  sessionId: z.string(),
  exitCode: z.number().int().optional(),
});

const SessionResumedEvent = z.object({
  type: z.literal("session:resumed"),
  sessionId: z.string(),
  restoredFromHistory: z.boolean(),
});

const SessionDeletedEvent = z.object({
  type: z.literal("session:deleted"),
  sessionId: z.string(),
});

// Metadata change that isn't a lifecycle-state transition (e.g. pin toggle).
// Carries only the fields that changed so the client can patch in place.
const SessionUpdatedEvent = z.object({
  type: z.literal("session:updated"),
  sessionId: z.string(),
  pinnedAt: z.string().nullable().optional(),
  /** New execution channel after a live JSON↔terminal toggle (P3, R1.7). */
  channel: z.enum(["tmux", "pty", "json"]).optional(),
});

/**
 * `reason` is the machine-readable classification of the error. Clients must
 * branch on it rather than regex-matching `message` (which is for humans and
 * free to change).
 *
 * - "gone"       — the session/pane genuinely no longer exists. Safe for the
 *                  client to treat as exited.
 * - "transient"  — attach/stream hiccup; the session may well still be alive.
 *                  Clients must NOT infer "exited" from this.
 */
const SessionErrorEvent = z.object({
  type: z.literal("session:error"),
  sessionId: z.string(),
  message: z.string(),
  reason: z.enum(["gone", "transient"]).optional(),
});

// File/tree watcher events
const FileChangedEvent = z.object({
  type: z.literal("file:changed"),
  worktreeId: z.string(),
  path: z.string(),
});

const FileDeletedEvent = z.object({
  type: z.literal("file:deleted"),
  worktreeId: z.string(),
  path: z.string(),
});

const TreeChangedEvent = z.object({
  type: z.literal("tree:changed"),
  worktreeId: z.string(),
  path: z.string(),
  kind: z.enum(["added", "deleted", "renamed"]),
  from: z.string().optional(),
  to: z.string().optional(),
});

// Broadcast events (all clients, low-frequency)
const ProjectCreatedEvent = z.object({
  type: z.literal("project:created"),
  project: z.record(z.string(), z.unknown()),
});

const ProjectDeletedEvent = z.object({
  type: z.literal("project:deleted"),
  projectId: z.string(),
});

const ProjectUpdatedEvent = z.object({
  type: z.literal("project:updated"),
  project: z.record(z.string(), z.unknown()),
});

const WorktreeCreatedEvent = z.object({
  type: z.literal("worktree:created"),
  worktree: z.record(z.string(), z.unknown()),
});

const WorktreeDeletedEvent = z.object({
  type: z.literal("worktree:deleted"),
  worktreeId: z.string(),
});

const WorktreeUpdatedEvent = z.object({
  type: z.literal("worktree:updated"),
  worktree: z.record(z.string(), z.unknown()),
});

const ModeCreatedEvent = z.object({
  type: z.literal("mode:created"),
  mode: z.record(z.string(), z.unknown()),
});

const ModeUpdatedEvent = z.object({
  type: z.literal("mode:updated"),
  mode: z.record(z.string(), z.unknown()),
});

const ModeDeletedEvent = z.object({
  type: z.literal("mode:deleted"),
  modeId: z.string(),
});

const PongMessage = z.object({
  type: z.literal("pong"),
});

const SystemErrorEvent = z.object({
  type: z.literal("system:error"),
  message: z.string(),
});

// JSON agent chat (S→C)
const ChatReplayEvent = z.object({
  type: z.literal("chat:replay"),
  sessionId: z.string(),
  events: z.array(NormalizedEventSchema),
  /** Keyset cursor for "load earlier" (R2.1) — `logSeq` of the oldest replayed
   *  event and whether older rows exist. Omitted on a `sinceSeq` delta replay. */
  oldestSeq: z.number().optional(),
  hasMore: z.boolean().optional(),
});

const SessionMessageEvent = z.object({
  type: z.literal("session:message"),
  sessionId: z.string(),
  event: NormalizedEventSchema,
});

const SessionMetaEvent = z.object({
  type: z.literal("session:meta"),
  sessionId: z.string(),
  meta: SessionMetaSchema,
});

// Edit-a-sent-message fork (P4/R3.6): tells other open tabs which turns were
// truncated so they drop the superseded bubbles and re-sync from the new head.
const SessionForkEvent = z.object({
  type: z.literal("session:fork"),
  sessionId: z.string(),
  supersededTurnIds: z.array(z.string()),
});

export const ServerMessage = z.discriminatedUnion("type", [
  // Per-session events
  SessionCreatedEvent,
  SessionStateEvent,
  SessionOpenedEvent,
  SessionOutputEvent,
  SessionExitedEvent,
  SessionResumedEvent,
  SessionDeletedEvent,
  SessionUpdatedEvent,
  SessionErrorEvent,
  // File/tree events
  FileChangedEvent,
  FileDeletedEvent,
  TreeChangedEvent,
  // Broadcast events
  ProjectCreatedEvent,
  ProjectDeletedEvent,
  ProjectUpdatedEvent,
  WorktreeCreatedEvent,
  WorktreeDeletedEvent,
  WorktreeUpdatedEvent,
  ModeCreatedEvent,
  ModeUpdatedEvent,
  ModeDeletedEvent,
  // JSON agent chat
  ChatReplayEvent,
  SessionMessageEvent,
  SessionMetaEvent,
  SessionForkEvent,
  // System
  PongMessage,
  SystemErrorEvent,
]);

export type ServerMessage = z.infer<typeof ServerMessage>;
