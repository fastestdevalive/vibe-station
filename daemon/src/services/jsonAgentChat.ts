/**
 * JSON agent-chat turn orchestration (Decision 3/5/8).
 *
 * The single place that turns a session id + a user message into an enqueued
 * turn on the session's `JsonAgentSession`: it resolves the mode → plugin, pins
 * the cwd (worktree or project), builds + writes the first-turn system prompt,
 * injects attachment paths (Decision 5), and enqueues. Reused by the REST chat
 * endpoints, the WS `chat:open` bridge, and the create-time turn-1 auto-enqueue.
 *
 * Kept out of `routes/*` so both routes and WS handlers can import it without a
 * route ↔ route import cycle.
 */

import { getAllProjects } from "../state/project-store.js";
import { resolvePlugin } from "../agent-plugins/registry.js";
import { jsonAgentRegistry } from "../state/jsonAgentRegistry.js";
import {
  getOrCreateJsonAgentSession,
  readTranscriptFromDataDir,
  readTailFromDataDir,
  readPageBeforeFromDataDir,
  readSinceFromDataDir,
  readMetaFromDataDir,
  buildMetaFromStoreMeta,
  injectAttachments,
  type JsonAgentSession,
} from "./jsonAgent.js";
import { sessionChannel } from "./channel.js";
import { sessionDataDir, directSessionDataDir } from "./paths.js";
import type { TranscriptPage } from "./transcriptStore.js";
import type {
  ProjectRecord,
  WorktreeRecord,
  SessionRecord,
  Attachment,
  NormalizedEvent,
  NormalizedEventProvider,
  SessionMeta,
} from "../types.js";

export interface JsonSessionContext {
  project: ProjectRecord;
  /** null for direct sessions. */
  worktree: WorktreeRecord | null;
  session: SessionRecord;
}

/** Locate a session (worktree or direct) across all projects. */
export function findJsonSessionContext(sessionId: string): JsonSessionContext | null {
  for (const project of getAllProjects()) {
    for (const worktree of project.worktrees) {
      const session = worktree.sessions.find((s) => s.id === sessionId);
      if (session) return { project, worktree, session };
    }
    const direct = project.directSessions.find((s) => s.id === sessionId);
    if (direct) return { project, worktree: null, session: direct };
  }
  return null;
}

/** Absolute per-session data dir (holds the transcript store + legacy backup). */
export function sessionDataDirFor(ctx: JsonSessionContext): string {
  return ctx.worktree
    ? sessionDataDir(ctx.project.id, ctx.worktree.id, ctx.session.id)
    : directSessionDataDir(ctx.project.id, ctx.session.id);
}

interface ResolvedMode {
  cli: NormalizedEventProvider;
  model?: string;
  modeId?: string;
  modeName?: string;
  context?: string;
}

async function resolveMode(session: SessionRecord): Promise<ResolvedMode> {
  const modeId = session.modeId;
  if (!modeId) throw new Error("Session has no mode; JSON chat requires an agent mode");
  const { loadModes } = await import("../routes/modes.js");
  const modes = await loadModes();
  const mode = modes.find((m) => m.id === modeId);
  if (!mode) throw new Error(`Mode '${modeId}' not found`);
  return {
    cli: mode.cli as NormalizedEventProvider,
    ...(mode.model ? { model: mode.model } : {}),
    modeId: mode.id,
    modeName: mode.name,
    ...(mode.context ? { context: mode.context } : {}),
  };
}

/**
 * Resolve (or lazily create + register) the `JsonAgentSession` for a session id.
 * Does NOT spawn anything — the process only starts when a turn is enqueued.
 */
export async function resolveJsonAgent(
  sessionId: string,
  daemonPort: number,
): Promise<
  | { ok: true; agent: JsonAgentSession; ctx: JsonSessionContext; mode: ResolvedMode }
  | { ok: false; reason: "not_found" | "not_json"; message: string }
> {
  const ctx = findJsonSessionContext(sessionId);
  if (!ctx) return { ok: false, reason: "not_found", message: `Session '${sessionId}' not found` };
  if (sessionChannel(ctx.session) !== "json") {
    return { ok: false, reason: "not_json", message: `Session '${sessionId}' is not a JSON-channel session` };
  }
  const mode = await resolveMode(ctx.session);
  const plugin = resolvePlugin(mode.cli);
  // A per-session model override (live status-bar switch) wins over the mode's
  // model when seeding the agent — so it survives restart and every turn spawns
  // with it. This single resolution point covers chat/edit/resubmit/meta.
  const seedModel = ctx.session.modelOverride ?? mode.model;
  const agent = getOrCreateJsonAgentSession({
    project: ctx.project,
    worktree: ctx.worktree,
    session: ctx.session,
    plugin,
    daemonPort,
    cli: mode.cli,
    ...(seedModel ? { model: seedModel } : {}),
    ...(mode.modeId ? { modeId: mode.modeId } : {}),
    ...(mode.modeName ? { modeName: mode.modeName } : {}),
  });
  return { ok: true, agent, ctx, mode };
}

/** Build the layered system prompt for a turn (worktree or direct session). */
async function buildSystemPrompt(ctx: JsonSessionContext, mode: ResolvedMode): Promise<string> {
  if (ctx.worktree) {
    const { buildPrompt } = await import("./promptBuilder.js");
    const built = await buildPrompt({
      project: ctx.project,
      worktree: ctx.worktree,
      ...(mode.context ? { modeContext: mode.context } : {}),
    });
    return built.systemPrompt;
  }
  const { buildDirectPrompt } = await import("./promptBuilder.js");
  const built = await buildDirectPrompt({
    project: ctx.project,
    ...(mode.context ? { modeContext: mode.context } : {}),
  });
  return built.systemPrompt;
}

/** Re-exported from `jsonAgent.ts` (injection is applied at run time — A1). */
export { injectAttachments };

export interface EnqueueChatResult {
  turnId: string;
  queuePosition: number;
}

/**
 * Enqueue a user turn on a session's JSON agent. Resolves the mode/plugin,
 * builds + supplies the system prompt for the first turn, and injects any
 * attachment paths. Throws on unresolved mode; returns null when the session is
 * missing or not a JSON session (caller maps to 404 / 400).
 */
export async function enqueueChatTurn(opts: {
  sessionId: string;
  message: string;
  attachments?: Attachment[];
  daemonPort: number;
}): Promise<
  | { ok: true; result: EnqueueChatResult }
  | { ok: false; reason: "not_found" | "not_json"; message: string }
> {
  const resolved = await resolveJsonAgent(opts.sessionId, opts.daemonPort);
  if (!resolved.ok) return resolved;
  const { agent, ctx, mode } = resolved;

  const attachments = opts.attachments ?? [];

  // System prompt only on the first (not-yet-run) turn — plugins gate on
  // `isFirstTurn`; resumed turns rely on the CLI's own session state.
  const systemPrompt = agent.isFirstTurnPending
    ? await buildSystemPrompt(ctx, mode)
    : undefined;

  // Enqueue the RAW message + attachment records; injection happens at run time
  // so the queued turn stays editable (queue-controls A1).
  const result = agent.enqueue({
    message: opts.message,
    ...(attachments.length ? { attachments } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  });
  return { ok: true, result };
}

/**
 * Auto-enqueue the create-dialog prompt as turn 1 (Decision 8 / CUJ 1). Called
 * in the background from the create routes for JSON agents. A blank prompt is a
 * no-op — the session waits for the user's first `POST /chat` to be turn 1.
 */
export async function startJsonCreateTurn(opts: {
  sessionId: string;
  prompt?: string;
  daemonPort: number;
}): Promise<void> {
  if (!opts.prompt || !opts.prompt.trim()) return;
  // The user can mark the session done (or dismiss it) between create and this
  // background call. Enqueuing then RE-CREATES the JsonAgentSession that the
  // release just tore down and spawns turn 1 against it — a session the user
  // believes is retired quietly starts burning tokens. A later, deliberate
  // `POST /chat` is still the documented way to resume; only this automatic
  // turn-1 is suppressed.
  const preCtx = findJsonSessionContext(opts.sessionId);
  if (!preCtx || preCtx.session.lifecycle.state === "done") return;
  const res = await enqueueChatTurn({
    sessionId: opts.sessionId,
    message: opts.prompt,
    daemonPort: opts.daemonPort,
  });
  if (!res.ok) {
    console.warn(`[json-chat] turn-1 auto-enqueue failed for ${opts.sessionId}: ${res.message}`);
    return;
  }
  const ctx = findJsonSessionContext(opts.sessionId);
  if (ctx) {
    const { persistLifecycleState } = await import("./lifecycle.js");
    await persistLifecycleState(ctx.project.id, ctx.worktree?.id, opts.sessionId, "working");
  }
}

/** Full transcript for a session (live session if registered, else disk). */
export function readSessionTranscript(ctx: JsonSessionContext): NormalizedEvent[] {
  const live = jsonAgentRegistry.get(ctx.session.id);
  if (live) return live.readTranscript();
  return readTranscriptFromDataDir(sessionDataDirFor(ctx), ctx.session.id);
}

/** Bounded tail-N turns + cursor (live session if registered, else disk) (R2.1). */
export function readSessionTail(ctx: JsonSessionContext, nTurns: number): TranscriptPage {
  const live = jsonAgentRegistry.get(ctx.session.id);
  if (live) return live.tail(nTurns);
  return readTailFromDataDir(sessionDataDirFor(ctx), ctx.session.id, nTurns);
}

/** Keyset "load earlier" page + cursor (live session if registered, else disk) (R2.2). */
export function readSessionPageBefore(
  ctx: JsonSessionContext,
  beforeSeq: number,
  limit: number,
): TranscriptPage {
  const live = jsonAgentRegistry.get(ctx.session.id);
  if (live) return live.pageBefore(beforeSeq, limit);
  return readPageBeforeFromDataDir(sessionDataDirFor(ctx), ctx.session.id, beforeSeq, limit);
}

/** Reconnect delta — events strictly newer than `sinceSeq` (R2.3). */
export function readSessionSince(ctx: JsonSessionContext, sinceSeq: number): NormalizedEvent[] {
  const live = jsonAgentRegistry.get(ctx.session.id);
  if (live) return live.since(sinceSeq);
  return readSinceFromDataDir(sessionDataDirFor(ctx), ctx.session.id, sinceSeq);
}

/** Latest meta for a session (live if registered, else rebuilt from transcript). */
export async function readSessionMeta(
  ctx: JsonSessionContext,
  daemonPort: number,
): Promise<SessionMeta> {
  const live = jsonAgentRegistry.get(ctx.session.id);
  if (live) return live.getMeta();
  // No live session — rebuild from the transcript tail.
  let cli = "claude";
  let modeId: string | undefined;
  let modeName: string | undefined;
  try {
    const mode = await resolveMode(ctx.session);
    cli = mode.cli;
    modeId = mode.modeId;
    modeName = mode.modeName;
  } catch {
    /* mode gone — fall back to a best-effort meta */
  }
  void daemonPort;
  // Bounded meta rebuild (R2.6): resolve the last model + last real usage via the
  // store's bounded reverse scan, never a whole-transcript read.
  return buildMetaFromStoreMeta({
    sessionId: ctx.session.id,
    cli,
    ...(modeId ? { modeId } : {}),
    ...(modeName ? { modeName } : {}),
    ...(ctx.session.modelOverride ? { modelOverride: ctx.session.modelOverride } : {}),
    meta: readMetaFromDataDir(sessionDataDirFor(ctx), ctx.session.id),
  });
}
