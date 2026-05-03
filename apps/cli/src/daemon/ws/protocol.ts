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
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

/**
 * Server-to-client messages.
 * Based on docs/API-CONTRACT.md WebSocket section.
 */

// Per-session events (subscribers / open streams)
const SessionCreatedSnapshot = z.object({
  id: z.string(),
  worktreeId: z.string(),
  slot: z.string(),
  type: z.enum(["agent", "terminal"]),
  modeId: z.string().nullable(),
  label: z.string(),
  tmuxName: z.string(),
  state: z.enum(["not_started", "working", "idle", "done", "exited"]),
  lifecycleState: z.enum(["not_started", "working", "idle", "done", "exited"]),
  createdAt: z.string(),
});

const SessionCreatedEvent = z.object({
  type: z.literal("session:created"),
  sessionId: z.string(),
  worktreeId: z.string(),
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

const SessionErrorEvent = z.object({
  type: z.literal("session:error"),
  sessionId: z.string(),
  message: z.string(),
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

const WorktreeCreatedEvent = z.object({
  type: z.literal("worktree:created"),
  worktree: z.record(z.string(), z.unknown()),
});

const WorktreeDeletedEvent = z.object({
  type: z.literal("worktree:deleted"),
  worktreeId: z.string(),
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

export const ServerMessage = z.discriminatedUnion("type", [
  // Per-session events
  SessionCreatedEvent,
  SessionStateEvent,
  SessionOpenedEvent,
  SessionOutputEvent,
  SessionExitedEvent,
  SessionResumedEvent,
  SessionDeletedEvent,
  SessionErrorEvent,
  // File/tree events
  FileChangedEvent,
  FileDeletedEvent,
  TreeChangedEvent,
  // Broadcast events
  ProjectCreatedEvent,
  ProjectDeletedEvent,
  WorktreeCreatedEvent,
  WorktreeDeletedEvent,
  ModeCreatedEvent,
  ModeUpdatedEvent,
  ModeDeletedEvent,
  // System
  PongMessage,
  SystemErrorEvent,
]);

export type ServerMessage = z.infer<typeof ServerMessage>;
