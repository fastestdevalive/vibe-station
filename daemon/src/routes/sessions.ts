import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAllProjects, getProject, mutateProject } from "../state/project-store.js";
import { generateSessionId, tmuxNameForSession } from "../services/sessionId.js";
import { slugifyPrompt } from "../services/naming.js";
import { forceCloseSessionStreams } from "../broadcaster.js";
import { killSession, newSession, pasteBuffer, capturePane, hasSession, sendKeys } from "../services/tmux.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { spawnSession, spawnSessionFromArgv, spawnDirectSession } from "../services/spawn.js";
import { resolvedContextOf } from "../services/context.js";
import type { AgentPlugin } from "../services/spawn.js";
import {
  cleanupSessionDataDir,
  cleanupDirectSessionDataDir,
  worktreePath,
  sessionDataDir,
  directSessionDataDir,
} from "../services/paths.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { broadcastAll } from "../broadcaster.js";
import { resolvePlugin } from "../agent-plugins/registry.js";
import { resolveUseTmux } from "../services/resolveUseTmux.js";
import { resolveChannel, sessionChannel, channelTransition } from "../services/channel.js";
import { hasNativeHistoryImporter } from "../services/nativeHistoryImporter.js";
import { persistLifecycleState, clearIdleTracking } from "../services/lifecycle.js";
import { jsonAgentRegistry } from "../state/jsonAgentRegistry.js";
import {
  enqueueChatTurn,
  findJsonSessionContext,
  readSessionTranscript,
  readSessionTail,
  readSessionPageBefore,
  readSessionSince,
  readSessionMeta,
  startJsonCreateTurn,
  resolveJsonAgent,
} from "../services/jsonAgentChat.js";
import { resolveCliModels } from "./modes.js";
import { getAttachment } from "../state/attachmentRegistry.js";
import { releaseSessionRuntime } from "../services/sessionRuntime.js";
import type { SessionRecord, WorktreeRecord, ProjectRecord, Channel, Attachment, SessionMeta } from "../types.js";

/**
 * Session creation supports two targets:
 * 1. Worktree session: runs in a git worktree (branch isolation)
 * 2. Direct session: runs in the project directory (no isolation)
 *
 * For backward compatibility, if `target` is absent, we infer from worktreeId presence.
 */
const WorktreeSessionBody = z.object({
  target: z.literal("worktree").optional(),
  worktreeId: z.string().min(1),
  type: z.enum(["agent", "terminal"]),
  modeId: z.string().min(1).nullish(),
  prompt: z.string().optional(),
  useTmux: z.boolean().optional(),
  channel: z.enum(["tmux", "pty", "json"]).optional(),
  name: z.string().trim().max(60).optional(),
  /** SessionId this session was spawned from (agent-interaction-workspaces/
   *  04-workspaces Phase 4a) — from an agent's own `vst --source-agent`
   *  invocation, or (future) an in-app dialog's source picker. Stored
   *  as-is, never validated against a real session — an unknown/dangling
   *  id is harmless (S5). */
  sourceAgentId: z.string().optional(),
  /** See `spawnNewSessionForChannel`'s doc — lets a JSON-channel caller pass
   *  `prompt` here purely for naming/initialPrompt without the daemon
   *  auto-enqueueing it as turn 1. */
  skipAutoTurn: z.boolean().optional(),
});

const DirectSessionBody = z.object({
  target: z.literal("direct"),
  projectId: z.string().min(1),
  type: z.enum(["agent", "terminal"]),
  modeId: z.string().min(1).nullish(),
  prompt: z.string().optional(),
  useTmux: z.boolean().optional(),
  channel: z.enum(["tmux", "pty", "json"]).optional(),
  name: z.string().trim().max(60).optional(),
  sourceAgentId: z.string().optional(),
  skipAutoTurn: z.boolean().optional(),
});

const CreateSessionBody = z.union([WorktreeSessionBody, DirectSessionBody]);

const ResetBody = z.object({
  handoff: z.boolean().optional(),
  prompt: z.string().optional(),
  handoffText: z.string().optional(),
  // Accepts either a mode id or a mode name — resolved the same way
  // session-create's `--mode` already is (see resolveModeId in routes/modes.ts).
  // Absent means "keep the outgoing session's mode", unchanged from before
  // this field existed.
  modeId: z.string().min(1).optional(),
});

const InputBody = z.object({
  data: z.string().min(1),
  sendEnter: z.boolean().optional(),
});

const ChatBody = z
  .object({
    message: z.string(),
    attachmentIds: z.array(z.string()).optional(),
  })
  // A files-only turn is valid: the first turn of a JSON agent may stage files
  // with no prompt (web-ui `firstTurn.ts`). Reject only when BOTH are empty.
  .refine((b) => b.message.trim().length > 0 || (b.attachmentIds?.length ?? 0) > 0, {
    message: "Provide a message or at least one attachment",
  });

// Body for POST …/chat/queue/:turnId/resubmit (queue-controls). Content fields
// are consulted ONLY when `edited` (A11); a discard (`edited:false`) restores
// the held turn unchanged. When editing, the same message-OR-attachment refine
// as `ChatBody` applies (A6/R6).
const ResubmitBody = z
  .object({
    edited: z.boolean(),
    message: z.string().optional(),
    attachmentIds: z.array(z.string()).optional(),
  })
  .refine(
    (b) =>
      !b.edited ||
      (b.message?.trim().length ?? 0) > 0 ||
      (b.attachmentIds?.length ?? 0) > 0,
    { message: "Provide a message or at least one attachment" },
  );

// Body for POST …/chat/fork (P4 edit-a-sent-message). Same message-OR-attachment
// invariant as `ChatBody` — the fork re-runs from turn N with the edited message.
const ForkBody = z
  .object({
    turnId: z.string(),
    message: z.string(),
    attachmentIds: z.array(z.string()).optional(),
  })
  .refine((b) => b.message.trim().length > 0 || (b.attachmentIds?.length ?? 0) > 0, {
    message: "Provide a message or at least one attachment",
  });

type SessionContext =
  | { kind: "worktree"; project: ProjectRecord; worktree: WorktreeRecord; session: SessionRecord }
  | { kind: "direct"; project: ProjectRecord; session: SessionRecord };

function findSessionContext(sessionId: string): SessionContext | null {
  for (const project of getAllProjects()) {
    // Check worktree sessions first
    for (const worktree of project.worktrees) {
      const session = worktree.sessions.find((s) => s.id === sessionId);
      if (session) return { kind: "worktree", project, worktree, session };
    }
    // Then check direct sessions
    const directSession = project.directSessions.find((s) => s.id === sessionId);
    if (directSession) return { kind: "direct", project, session: directSession };
  }
  return null;
}

function findWorktreeContext(
  worktreeId: string,
): { project: ProjectRecord; worktree: WorktreeRecord } | null {
  for (const project of getAllProjects()) {
    const worktree = project.worktrees.find((w) => w.id === worktreeId);
    if (worktree) return { project, worktree };
  }
  return null;
}

/**
 * A spawn job finished — but the user may have marked the session `done` (or
 * dismissed it) while the spawn was still in flight, which is easy to do since
 * a spawn takes seconds. Two things then go wrong unless we re-check:
 *
 *  1. The job's completion write would clobber `done` with `working`/`exited`
 *     (it also writes back a STALE captured `session` object).
 *  2. Worse, the spawn created its pane/child AFTER the release already killed
 *     everything — a leaked process the user believes they retired.
 *
 * So: if the session is no longer live by the time the spawn lands, release
 * whatever it just created and skip the lifecycle write entirely.
 *
 * Returns true when the caller should skip its own persist/broadcast.
 */
async function releaseIfRetiredDuringSpawn(sessionId: string): Promise<boolean> {
  const ctx = findSessionContext(sessionId);
  // Gone entirely (dismissed mid-spawn) — nothing left to write to, but the
  // spawn may still have produced a pane after DELETE's teardown ran.
  if (!ctx) return true;
  if (ctx.session.lifecycle.state !== "done") return false;
  await releaseSessionRuntime(ctx.session);
  return true;
}

async function runAgentSpawnJob(opts: {
  project: ProjectRecord;
  worktree: WorktreeRecord;
  session: SessionRecord;
  modeId: string;
  prompt: string | undefined;
  daemonPort: number;
}): Promise<void> {
  const { project, worktree, session, modeId, prompt, daemonPort } = opts;
  const sessionId = session.id;
  const worktreeId = worktree.id;
  try {
    const modes = await (await import("../routes/modes.js")).loadModes();
    const mode = modes.find((m) => m.id === modeId);
    if (!mode) throw new Error(`Mode '${modeId}' not found`);
    const plugin = resolvePlugin(mode.cli);
    const { buildPrompt } = await import("../services/promptBuilder.js");
    const builtPrompt = await buildPrompt({
      project,
      worktree,
      modeContext: mode.context,
      userPrompt: prompt,
    });
    await spawnSession({
      project,
      worktree,
      session,
      plugin,
      daemonPort,
      systemPrompt: builtPrompt.systemPrompt,
      taskPrompt: builtPrompt.taskPrompt,
      model: mode.model,
    });
    if (await releaseIfRetiredDuringSpawn(sessionId)) return;
    session.lifecycle = { state: "working", lastTransitionAt: new Date().toISOString() };
    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktreeId
          ? { ...w, sessions: w.sessions.map((s) => (s.id === sessionId ? session : s)) }
          : w,
      ),
    }));
    broadcastAll({ type: "session:state", sessionId, state: "working" });
  } catch (err) {
    const reason = String(err);
    if (await releaseIfRetiredDuringSpawn(sessionId)) return;
    session.lifecycle = { state: "exited", lastTransitionAt: new Date().toISOString() };
    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktreeId
          ? { ...w, sessions: w.sessions.map((s) => (s.id === sessionId ? session : s)) }
          : w,
      ),
    }));
    broadcastAll({ type: "session:state", sessionId, state: "exited", reason });
  }
}

/**
 * Background job to spawn a direct agent session (no worktree).
 */
async function runDirectAgentSpawnJob(opts: {
  project: ProjectRecord;
  session: SessionRecord;
  modeId: string;
  prompt: string | undefined;
  daemonPort: number;
}): Promise<void> {
  const { project, session, modeId, prompt, daemonPort } = opts;
  const sessionId = session.id;
  try {
    const modes = await (await import("../routes/modes.js")).loadModes();
    const mode = modes.find((m) => m.id === modeId);
    if (!mode) throw new Error(`Mode '${modeId}' not found`);
    const plugin = resolvePlugin(mode.cli);
    const { buildDirectPrompt } = await import("../services/promptBuilder.js");
    const builtPrompt = await buildDirectPrompt({
      project,
      modeContext: mode.context,
      userPrompt: prompt,
    });
    await spawnDirectSession({
      project,
      session,
      plugin,
      daemonPort,
      systemPrompt: builtPrompt.systemPrompt,
      taskPrompt: builtPrompt.taskPrompt,
      model: mode.model,
    });
    if (await releaseIfRetiredDuringSpawn(sessionId)) return;
    session.lifecycle = { state: "working", lastTransitionAt: new Date().toISOString() };
    await mutateProject(project.id, (p) => ({
      ...p,
      directSessions: p.directSessions.map((s) => (s.id === sessionId ? session : s)),
    }));
    broadcastAll({ type: "session:state", sessionId, state: "working" });
  } catch (err) {
    const reason = String(err);
    if (await releaseIfRetiredDuringSpawn(sessionId)) return;
    session.lifecycle = { state: "exited", lastTransitionAt: new Date().toISOString() };
    await mutateProject(project.id, (p) => ({
      ...p,
      directSessions: p.directSessions.map((s) => (s.id === sessionId ? session : s)),
    }));
    broadcastAll({ type: "session:state", sessionId, state: "exited", reason });
  }
}

/**
 * Spawn a freshly-created (or reset) agent session's runtime, branching on
 * channel exactly the way session creation does (Bug 1/2 fix). JSON-channel
 * sessions never spawn a raw PTY — the process only starts once a turn is
 * enqueued via `startJsonCreateTurn`; tmux/pty-channel sessions go through the
 * guarded spawn jobs above (`runAgentSpawnJob` / `runDirectAgentSpawnJob`),
 * which already catch spawn failures, persist `agentChatId`, flip lifecycle to
 * working/exited, and broadcast `session:state` — never a raw, unguarded
 * `spawnSession`/`spawnDirectSession` call (which has none of that, and — with
 * no global `unhandledRejection` handler anywhere in this codebase — can crash
 * the entire daemon process on a spawn failure).
 *
 * Shared by both session-creation routes and `/sessions/:id/reset` so reset's
 * spawn logic can never silently drift from creation's again.
 */
async function spawnNewSessionForChannel(opts: {
  project: ProjectRecord;
  worktree?: WorktreeRecord;
  session: SessionRecord;
  modeId: string;
  prompt: string | undefined;
  daemonPort: number;
  /** See `skipAutoTurn` on `WorktreeSessionBody`/`DirectSessionBody` above:
   *  caller included `prompt` only so naming/initialPrompt could be derived
   *  from it, and will send the real turn 1 itself (after uploading staged
   *  attachments) — don't also auto-enqueue it here. Defaults to false so
   *  `/sessions/:id/reset`'s call site (no create-dialog body to speak of)
   *  keeps its existing auto-enqueue behavior unchanged. */
  skipAutoTurn?: boolean;
}): Promise<void> {
  const { project, worktree, session, modeId, prompt, daemonPort, skipAutoTurn } = opts;
  if (sessionChannel(session) === "json") {
    if (skipAutoTurn) return;
    try {
      await startJsonCreateTurn({ sessionId: session.id, prompt, daemonPort });
    } catch (err) {
      // Called fire-and-forget (`void spawnNewSessionForChannel(...)`) by every
      // caller, and there is no global unhandledRejection handler in this
      // process — a bare throw here would crash the whole daemon.
      console.warn(`[spawn] json turn-1 start failed for session ${session.id}: ${String(err)}`);
    }
    return;
  }
  if (worktree) {
    await runAgentSpawnJob({ project, worktree, session, modeId, prompt, daemonPort });
  } else {
    await runDirectAgentSpawnJob({ project, session, modeId, prompt, daemonPort });
  }
}

/**
 * Flatten SessionRecord's nested lifecycle and add UI-required fields (REST +
 * WS snapshot).
 *
 * Deliberately does NOT include a computed `label`/display-name field — the
 * client derives that itself from `name`/`isMain`/`type` via `sessionLabel()`
 * in `web-ui/src/lib/sessionLabel.ts` (mirror any change to the fallback rule
 * there — "no name -> 'main' for the main session, else 'Agent'/'Terminal'"
 * — in both places). A previous version of this endpoint computed and sent a
 * separate `label` field; that meant two values could represent one
 * displayed string, and a rename broadcast that patched `name` but forgot to
 * also patch `label` left the UI showing stale text until an unrelated
 * refetch recomputed it. Sending only `name` removes the second value
 * entirely, so there's nothing left to go stale independently.
 */
export function serializeSession(worktreeId: string | null, projectId: string, s: SessionRecord) {
  return {
    id: s.id,
    worktreeId,
    projectId,
    isMain: s.isMain,
    type: s.type,
    modeId: s.modeId ?? null,
    name: s.name ?? null,
    nameSource: s.nameSource ?? null,
    tmuxName: s.tmuxName,
    useTmux: s.useTmux,
    channel: sessionChannel(s),
    state: s.lifecycle.state,
    lifecycleState: s.lifecycle.state,
    createdAt: s.lifecycle.lastTransitionAt,
    pinnedAt: s.pinnedAt ?? null,
    archivedAt: s.archivedAt ?? null,
    sortOrder: s.sortOrder,
    handoffSummary: s.handoffSummary ?? null,
    spawnedFrom: s.spawnedFrom ?? null,
    supersededBy: s.supersededBy ?? null,
    pr: s.pr ?? null,
  };
}

export function registerSessionRoutes(app: FastifyInstance): void {
  // GET /sessions?worktree=:id or GET /sessions?project=:id or GET /sessions (all)
  app.get("/sessions", async (req, reply) => {
    const { worktree: wtId, project: projectId } = req.query as { worktree?: string; project?: string };

    if (wtId) {
      const ctx = findWorktreeContext(wtId);
      if (!ctx) return reply.status(404).send({ error: `Worktree '${wtId}' not found` });
      return reply.send(ctx.worktree.sessions.map((s) => serializeSession(ctx.worktree.id, ctx.project.id, s)));
    }

    if (projectId) {
      const project = getProject(projectId);
      if (!project) return reply.status(404).send({ error: `Project '${projectId}' not found` });
      // Return both worktree sessions and direct sessions for this project
      const worktreeSessions = project.worktrees.flatMap((w) =>
        w.sessions.map((s) => serializeSession(w.id, project.id, s)),
      );
      const directSessions = project.directSessions.map((s) => serializeSession(null, project.id, s));
      return reply.send([...worktreeSessions, ...directSessions]);
    }

    // Return all sessions (worktree + direct) across all projects
    const all = getAllProjects().flatMap((p) => [
      ...p.worktrees.flatMap((w) => w.sessions.map((s) => serializeSession(w.id, p.id, s))),
      ...p.directSessions.map((s) => serializeSession(null, p.id, s)),
    ]);
    return reply.send(all);
  });

  // GET /worktrees/:worktreeId/next-terminal-name — the default name the next
  // terminal would get (monotonic; does not increment). Used to prefill the
  // New Terminal dialog with an editable suggestion.
  app.get("/worktrees/:worktreeId/next-terminal-name", async (req, reply) => {
    const { worktreeId } = req.params as { worktreeId: string };
    const ctx = findWorktreeContext(worktreeId);
    if (!ctx) return reply.status(404).send({ error: `Worktree '${worktreeId}' not found` });
    const next = (ctx.worktree.terminalSeq ?? 0) + 1;
    return reply.send({ name: `Terminal ${next}` });
  });

  // GET /sessions/:id
  app.get("/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    if (ctx.kind === "worktree") {
      return reply.send(serializeSession(ctx.worktree.id, ctx.project.id, ctx.session));
    }
    return reply.send(serializeSession(null, ctx.project.id, ctx.session));
  });

  // GET /sessions/:id/output?lines=N
  app.get("/sessions/:id/output", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { lines } = req.query as { lines?: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    const n = Math.min(Math.max(parseInt(lines ?? "100", 10) || 100, 1), 10000);

    if (!ctx.session.useTmux) {
      const stream = directPtyRegistry.get(id);
      const output = stream ? (stream.getRecentOutput?.(n * 200) ?? "") : "";
      return reply.send({ id, output });
    }

    const output = await capturePane(ctx.session.tmuxName, { lines: n });
    return reply.send({ id, output });
  });

  // POST /sessions — create in worktree or directly in project
  app.post("/sessions", async (req, reply) => {
    const result = CreateSessionBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Validation error", details: result.error.issues });
    }

    const data = result.data;
    const { type, prompt, useTmux: rawUseTmux } = data;
    let { modeId } = data;
    // Channel resolution (Decision 1/11): `channel: "json"` pins useTmux=false;
    // otherwise fall back to the tmux/pty split.
    const isJson = data.channel === "json";
    const useTmux = isJson ? false : resolveUseTmux(rawUseTmux);
    const channel: Channel = data.channel ?? resolveChannel(useTmux);

    if (type === "agent" && !modeId) {
      return reply.status(400).send({ error: "'modeId' is required for agent sessions" });
    }

    // Resolve modeId by name fallback so CLI callers using --mode <name> work.
    if (type === "agent" && modeId) {
      try {
        const { resolveModeId } = await import("../routes/modes.js");
        modeId = await resolveModeId(modeId);
      } catch {
        return reply.status(400).send({ error: `Mode '${modeId}' not found` });
      }
    }

    // Create-time JSON-capability gate: a JSON-channel agent is only valid when
    // its CLI's plugin supportsJson(). Reject early (covers both the direct and
    // worktree/additional-agent branches below) so we never spawn a broken JSON
    // session for a CLI that is deliberately gated off.
    if (isJson && type === "agent" && modeId) {
      const { jsonUnsupportedCli } = await import("../routes/modes.js");
      const cli = await jsonUnsupportedCli(modeId);
      if (cli) {
        return reply.status(400).send({ error: `${cli} does not support JSON chat mode` });
      }
    }

    // Determine target: direct session vs worktree session
    // For backward compat, if no explicit target, infer from worktreeId presence
    const isDirect = data.target === "direct" || !("worktreeId" in data);

    if (isDirect) {
      // --- DIRECT SESSION (in project directory) ---
      const projectId = "projectId" in data ? data.projectId : undefined;
      if (!projectId) {
        return reply.status(400).send({ error: "projectId is required for direct sessions" });
      }

      const project = getProject(projectId);
      if (!project) {
        return reply.status(404).send({ error: `Project '${projectId}' not found` });
      }

      // Session id is independently generated (Decision 1) — no longer
      // slot-derived, so a later reset's replacement id can never collide
      // with this one.
      const sessionId = generateSessionId(projectId, type);
      const tmuxName = useTmux ? tmuxNameForSession(sessionId) : `__direct__-${sessionId}`;

      // Default naming (Decision 5): `directSessionSeq` now numbers EVERY
      // direct session (agent or terminal), not just terminals — it's the
      // only place left that can hand out a stable "N" once slot is gone.
      const nextDirectSeq = (project.directSessionSeq ?? 0) + 1;
      const provided = data.name;
      let sessionName: string | undefined;
      let nameSource: SessionRecord["nameSource"];
      if (provided && provided.length > 0) {
        sessionName = provided;
        nameSource = "user";
      } else if (type === "agent" && prompt) {
        const slug = slugifyPrompt(prompt);
        if (slug) {
          sessionName = slug;
          nameSource = "auto";
        }
      }
      if (!sessionName) {
        sessionName = type === "terminal" ? `Terminal ${nextDirectSeq}` : `Direct ${nextDirectSeq}`;
      }

      const sessionRecord: SessionRecord = {
        id: sessionId,
        projectId: project.id,
        isMain: false,
        sortOrder: Date.now(),
        type,
        modeId: type === "agent" ? (modeId ?? undefined) : undefined,
        name: sessionName,
        ...(nameSource ? { nameSource } : {}),
        tmuxName,
        useTmux,
        channel,
        ...(isJson
          ? {
              transcriptRef: {
                kind: "vst-json" as const,
                path: join(directSessionDataDir(project.id, sessionId), "messages.jsonl"),
              },
            }
          : {}),
        lifecycle: {
          state: "not_started",
          lastTransitionAt: new Date().toISOString(),
        },
        ...(type === "agent" && prompt ? { initialPrompt: prompt } : {}),
        spawnedFrom: data.sourceAgentId ?? null,
      };

      // Spawn terminal immediately if type=terminal
      if (type === "terminal") {
        try {
          if (useTmux) {
            await newSession({ name: tmuxName, cwd: project.absolutePath });
          } else {
            const { DirectPtyBackend } = await import("../services/directPty.js");
            await DirectPtyBackend.spawn({
              command: process.env.SHELL ?? "/bin/bash",
              args: [],
              cwd: project.absolutePath,
              env: { ...process.env as Record<string, string> },
              cols: 80,
              rows: 24,
              sessionId,
              projectId: project.id,
              worktreeId: undefined,
            });
          }
          sessionRecord.lifecycle = {
            state: "working",
            lastTransitionAt: new Date().toISOString(),
          };
        } catch (err) {
          return reply.status(500).send({ error: `Failed to spawn terminal: ${String(err)}` });
        }
      }

      // Persist direct session
      await mutateProject(project.id, (p) => ({
        ...p,
        directSessionSeq: nextDirectSeq,
        directSessions: [...p.directSessions, sessionRecord],
      }));

      // Broadcast
      broadcastAll({
        type: "session:created",
        sessionId,
        projectId: project.id,
        worktreeId: null,
        sessionType: type,
        mode: typeof modeId === "string" ? modeId : undefined,
        spawnedFrom: sessionRecord.spawnedFrom ?? null,
        snapshot: serializeSession(null, project.id, sessionRecord),
      });

      // Spawn agent in background. JSON-channel sessions do NOT spawn a TTY at
      // create (Decision 2/8) — the process starts on turn 1, auto-enqueued from
      // the create-dialog prompt via the JSON turn queue.
      if (type === "agent" && modeId) {
        const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;
        void spawnNewSessionForChannel({
          project,
          session: sessionRecord,
          modeId,
          prompt,
          daemonPort,
          skipAutoTurn: data.skipAutoTurn,
        });
      }

      return reply.status(201).send(serializeSession(null, project.id, sessionRecord));
    }

    // --- WORKTREE SESSION (existing behavior) ---
    const worktreeId = "worktreeId" in data ? data.worktreeId : undefined;
    if (!worktreeId) {
      return reply.status(400).send({ error: "worktreeId is required for worktree sessions" });
    }

    const ctx = findWorktreeContext(worktreeId);
    if (!ctx) return reply.status(404).send({ error: `Worktree '${worktreeId}' not found` });

    const { project, worktree } = ctx;

    // Session id is independently generated (Decision 1) — not slot-derived.
    const sessionId = generateSessionId(worktreeId, type);
    const tmuxName = useTmux ? tmuxNameForSession(sessionId) : `__direct__-${sessionId}`;

    // Terminal naming: monotonic per-worktree counter (never reused).
    let nextTerminalSeq: number | undefined;
    // Agent naming: monotonic per-worktree counter (never reused), used only
    // as the fallback default label when no prompt-derived name applies
    // (Decision 5).
    let nextAgentSeq: number | undefined;
    let sessionName: string | undefined;
    let nameSource: SessionRecord["nameSource"];
    const provided = data.name;
    if (provided && provided.length > 0) {
      sessionName = provided;
      nameSource = "user";
    } else if (type === "agent" && prompt) {
      const slug = slugifyPrompt(prompt);
      if (slug) {
        sessionName = slug;
        nameSource = "auto";
      }
    }
    if (!sessionName) {
      if (type === "terminal") {
        nextTerminalSeq = (worktree.terminalSeq ?? 0) + 1;
        sessionName = `Terminal ${nextTerminalSeq}`;
      } else {
        nextAgentSeq = (worktree.agentSeq ?? 0) + 1;
        sessionName = `Agent ${nextAgentSeq}`;
      }
    } else if (type === "agent") {
      nextAgentSeq = (worktree.agentSeq ?? 0) + 1;
    }

    const sessionRecord: SessionRecord = {
      id: sessionId,
      worktreeId,
      projectId: project.id,
      isMain: false,
      sortOrder: Date.now(),
      type,
      modeId: type === "agent" ? (modeId ?? undefined) : undefined,
      name: sessionName,
      ...(nameSource ? { nameSource } : {}),
      tmuxName,
      useTmux,
      channel,
      ...(isJson
        ? {
            transcriptRef: {
              kind: "vst-json" as const,
              path: join(sessionDataDir(project.id, worktreeId, sessionId), "messages.jsonl"),
            },
          }
        : {}),
      lifecycle: {
        state: "not_started",
        lastTransitionAt: new Date().toISOString(),
      },
      ...(type === "agent" && prompt ? { initialPrompt: prompt } : {}),
      spawnedFrom: data.sourceAgentId ?? null,
    };

    // Spawn terminal session immediately if type=terminal
    if (type === "terminal") {
      try {
        const { worktreePath: getWtPath } = await import("../services/paths.js");
        const wtPath = getWtPath(project.id, worktree.id);
        if (useTmux) {
          await newSession({ name: tmuxName, cwd: wtPath });
        } else {
          const { DirectPtyBackend } = await import("../services/directPty.js");
          await DirectPtyBackend.spawn({
            command: process.env.SHELL ?? "/bin/bash",
            args: [],
            cwd: wtPath,
            env: { ...process.env as Record<string, string> },
            cols: 80,
            rows: 24,
            sessionId,
            projectId: project.id,
            worktreeId,
          });
        }
        sessionRecord.lifecycle = {
          state: "working",
          lastTransitionAt: new Date().toISOString(),
        };
      } catch (err) {
        return reply.status(500).send({ error: `Failed to spawn terminal: ${String(err)}` });
      }
    }

    // Persist (also advance the worktree's terminal counter for terminals)
    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktreeId
          ? {
              ...w,
              ...(nextTerminalSeq != null ? { terminalSeq: nextTerminalSeq } : {}),
              ...(nextAgentSeq != null ? { agentSeq: nextAgentSeq } : {}),
              sessions: [...w.sessions, sessionRecord],
            }
          : w,
      ),
    }));

    // Broadcast and return immediately — agent spawn runs in background.
    broadcastAll({
      type: "session:created",
      sessionId,
      projectId: project.id,
      worktreeId,
      sessionType: type,
      mode: typeof modeId === "string" ? modeId : undefined,
      spawnedFrom: sessionRecord.spawnedFrom ?? null,
      snapshot: serializeSession(worktreeId, project.id, sessionRecord),
    });

    // JSON-channel sessions do NOT spawn a TTY at create (Decision 2/8) — the
    // process starts on turn 1, auto-enqueued from the create-dialog prompt.
    if (type === "agent" && modeId) {
      const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;
      void spawnNewSessionForChannel({
        project,
        worktree,
        session: sessionRecord,
        modeId,
        prompt,
        daemonPort,
        skipAutoTurn: data.skipAutoTurn,
      });
    }

    return reply.status(201).send(serializeSession(worktreeId, project.id, sessionRecord));
  });

  // DELETE /sessions/:id
  app.delete("/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const { project, session } = ctx;

    if (ctx.kind !== "worktree") {
      // Direct session: isMain is impossible (DB CHECK), so no promotion
      // logic applies — plain delete only.
      await releaseSessionRuntime(session, { clearAttachments: true });
      cleanupDirectSessionDataDir(project.id, id);
      await mutateProject(project.id, (p) => ({
        ...p,
        directSessions: p.directSessions.filter((s) => s.id !== id),
      }));
      broadcastAll({ type: "session:deleted", sessionId: id });
      return reply.send({ ok: true });
    }

    const NO_SIBLING_ERROR =
      "Cannot delete the main session: no other agent session exists in this worktree " +
      "to promote to main. Use DELETE /worktrees/:id to remove the whole worktree.";

    // Fast-path pre-check OUTSIDE the lock — pure optimization so the common
    // "main session, sole session in the worktree" case 400s immediately
    // without an extra DB round trip. Based on `session`/`ctx.worktree`
    // captured at the very top of the handler, so NOT authoritative: it can
    // only ever short-circuit to the SAME outcome the in-lock check below
    // would reach anyway (a false negative here just skips the optimization,
    // never skips the real check) — see the unified in-lock logic for why.
    if (session.isMain) {
      const hasAnyEligibleSibling = ctx.worktree.sessions.some(
        (s) => s.id !== session.id && s.type === "agent" && s.archivedAt == null,
      );
      if (!hasAnyEligibleSibling) {
        return reply.status(400).send({ error: NO_SIBLING_ERROR });
      }
    }

    class SessionGoneAtCommit extends Error {}
    class NoEligibleSiblingAtCommit extends Error {}
    let promotedId: string | undefined;
    let promotedPr: SessionRecord["pr"];
    let promotedAtCommit = false;

    try {
      // Whether THIS delete is "the main session, needs promotion" or "just
      // remove it" is decided fresh, INSIDE this one locked callback, off the
      // `p`/`w` mutateProject hands in — never off `session`/`ctx.worktree`
      // captured before this call. This closes the race in BOTH directions
      // (not just "promotion candidate went stale," Decision 1's original
      // scope): a concurrent request can also PROMOTE this exact session to
      // main between this handler's start and the lock being acquired — a
      // stale `session.isMain === false` read would otherwise let a plain
      // unconditional-filter delete remove the worktree's only main session
      // out from under a racing promotion, leaving zero live sessions
      // (confirmed empirically before this fix — see M3/A1.T7's test).
      await mutateProject(project.id, (p) => {
        const w = p.worktrees.find((x) => x.id === ctx.worktree.id);
        if (!w) throw new Error(`Worktree '${ctx.worktree.id}' not found`);
        const fresh = w.sessions.find((s) => s.id === id);
        if (!fresh) throw new SessionGoneAtCommit(); // a concurrent request already removed it
        if (!fresh.isMain) {
          // Not main at commit time (whether or not it looked main at
          // request start) — plain delete.
          return {
            ...p,
            worktrees: p.worktrees.map((ww) =>
              ww.id === ctx.worktree.id ? { ...ww, sessions: ww.sessions.filter((s) => s.id !== id) } : ww,
            ),
          };
        }
        const siblings = w.sessions
          .filter((s) => s.id !== id && s.type === "agent" && s.archivedAt == null)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        const promoted = siblings[0];
        if (!promoted) throw new NoEligibleSiblingAtCommit();
        promotedId = promoted.id;
        // Carry the OLD main's `pr` onto the promoted session so PR-colored
        // surfaces don't blank for up to 30s until the next prPoller tick.
        promotedPr = fresh.pr;
        promotedAtCommit = true;
        return {
          ...p,
          worktrees: p.worktrees.map((ww) =>
            ww.id === ctx.worktree.id
              ? {
                  ...ww,
                  sessions: ww.sessions
                    .filter((s) => s.id !== id)
                    .map((s) => (s.id === promoted.id ? { ...s, isMain: true, pr: fresh.pr } : s)),
                }
              : ww,
          ),
        };
      });
    } catch (err) {
      if (err instanceof SessionGoneAtCommit) {
        return reply.status(404).send({ error: `Session '${id}' not found` });
      }
      if (err instanceof NoEligibleSiblingAtCommit) {
        // Lost a race: every eligible sibling was removed/reset between the
        // fast-path check above (or this session becoming main after it)
        // and this locked commit. mutateProject never called
        // writeProjectFull (fn is invoked BEFORE the try/writeProjectFull
        // block), so nothing persisted and the cache is untouched.
        return reply.status(400).send({ error: NO_SIBLING_ERROR });
      }
      throw err; // genuine unexpected failure — surfaces as a 500, not swallowed
    }

    // Persisted state now has the delete (and, if applicable, the promotion)
    // committed. Runtime teardown uses the `session` object fetched at the
    // top of the handler, which is still valid regardless of DB state.
    await releaseSessionRuntime(session, { clearAttachments: true });
    cleanupSessionDataDir(project.id, ctx.worktree.id, id);

    if (promotedAtCommit) {
      broadcastAll({ type: "session:updated", sessionId: promotedId!, isMain: true, pr: promotedPr ?? null });
    }
    broadcastAll({ type: "session:deleted", sessionId: id });
    return reply.send({ ok: true });
  });

  // PATCH /sessions/:id/pin   { pinned: boolean }
  // Toggle SessionRecord.pinnedAt. Idempotent — no-op when already in the
  // requested state (so cross-tab pins don't bounce the timestamp). Works for
  // both direct and worktree sessions.
  app.patch("/sessions/:id/pin", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ pinned: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    }
    const { pinned } = parsed.data;

    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const already = ctx.session.pinnedAt != null;
    if (already === pinned) {
      // No state change.
      return reply.send({ ok: true, pinnedAt: ctx.session.pinnedAt ?? null });
    }

    const nextPinnedAt = pinned ? new Date().toISOString() : undefined;
    const patchSession = (s: SessionRecord): SessionRecord => {
      if (pinned) return { ...s, pinnedAt: nextPinnedAt };
      // Drop the field rather than setting undefined so the manifest stays clean.
      const { pinnedAt: _drop, ...rest } = s;
      void _drop;
      return rest;
    };

    await mutateProject(ctx.project.id, (p) => {
      if (ctx.kind === "worktree") {
        return {
          ...p,
          worktrees: p.worktrees.map((w) =>
            w.id === ctx.worktree.id
              ? { ...w, sessions: w.sessions.map((s) => (s.id === id ? patchSession(s) : s)) }
              : w,
          ),
        };
      }
      return {
        ...p,
        directSessions: p.directSessions.map((s) => (s.id === id ? patchSession(s) : s)),
      };
    });

    broadcastAll({ type: "session:updated", sessionId: id, pinnedAt: nextPinnedAt ?? null });
    return reply.send({ ok: true, pinnedAt: nextPinnedAt ?? null });
  });

  // PATCH /sessions/:id/rename   { name: string }
  // Cosmetic-only (Requirement 4/Decision 4). Empty string clears the override
  // back to NULL (falls back to the computed default label), same as never
  // having set a name. Works for both worktree and direct sessions.
  app.patch("/sessions/:id/rename", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ name: z.string().max(60) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    }
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const value = parsed.data.name.trim() === "" ? null : parsed.data.name.trim().slice(0, 60);
    const patchSession = (s: SessionRecord): SessionRecord => {
      if (s.id !== id) return s;
      const next = { ...s, nameSource: "user" as const };
      if (value == null) {
        delete next.name;
      } else {
        next.name = value;
      }
      return next;
    };

    await mutateProject(ctx.project.id, (p) =>
      ctx.kind === "worktree"
        ? {
            ...p,
            worktrees: p.worktrees.map((w) =>
              w.id === ctx.worktree.id ? { ...w, sessions: w.sessions.map(patchSession) } : w,
            ),
          }
        : { ...p, directSessions: p.directSessions.map(patchSession) },
    );

    broadcastAll({ type: "session:updated", sessionId: id, name: value });
    return reply.send({ ok: true, name: value });
  });

  // PATCH /sessions/:id/reorder   { sortOrder: number }
  // Cosmetic-only display-order rank within the session's scope (worktree, or
  // project's direct sessions). Client computes the fractional value (Part
  // 03 Decision 1) — this endpoint just persists whatever it's given.
  app.patch("/sessions/:id/reorder", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ sortOrder: z.number() }).safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    }
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const value = parsed.data.sortOrder;
    const patchSession = (s: SessionRecord): SessionRecord => (s.id !== id ? s : { ...s, sortOrder: value });

    await mutateProject(ctx.project.id, (p) =>
      ctx.kind === "worktree"
        ? {
            ...p,
            worktrees: p.worktrees.map((w) =>
              w.id === ctx.worktree.id ? { ...w, sessions: w.sessions.map(patchSession) } : w,
            ),
          }
        : { ...p, directSessions: p.directSessions.map(patchSession) },
    );

    broadcastAll({ type: "session:updated", sessionId: id, sortOrder: value });
    return reply.send({ ok: true, sortOrder: value });
  });

  // POST /sessions/:id/done — retire an agent session: RELEASE its runtime
  // resources (tmux pane / direct-pty child / JsonAgentSession + SQLite handle)
  // and mark it `done`. Everything needed for a later `POST /:id/resume`
  // survives — the manifest record with its `agentChatId`, the session data
  // dir, staged attachments, and the CLI's own history — so "done" is a pause,
  // not a delete. Terminals have no "done" concept, so reject them.
  app.post("/sessions/:id/done", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    if (ctx.session.type !== "agent") {
      return reply.status(400).send({ error: "Only agent sessions can be marked done." });
    }
    // Idempotent: a repeat call has nothing left to release.
    if (ctx.session.lifecycle.state === "done") return reply.send({ ok: true });

    // Release BEFORE persisting so the `done` broadcast is the last word the
    // clients hear: releasing a JSON session unwinds its drain, which would
    // otherwise persist a trailing `idle` (the `released` latch inside
    // `JsonAgentSession` suppresses it, but ordering costs nothing).
    await releaseSessionRuntime(ctx.session);

    ctx.session.lifecycle = { state: "done", lastTransitionAt: new Date().toISOString() };
    // persistLifecycleState handles both the worktree and direct branches and
    // broadcasts session:state itself.
    await persistLifecycleState(
      ctx.project.id,
      ctx.kind === "worktree" ? ctx.worktree.id : undefined,
      id,
      "done",
    );

    // Drop the replay-only initial prompt now the session is explicitly
    // done — a future resume must never re-issue it (see the resume
    // handler's `replayInitialPrompt` gate).
    if (ctx.session.initialPrompt) {
      const stripInitialPrompt = (s: SessionRecord): SessionRecord =>
        s.id === id ? { ...s, initialPrompt: undefined } : s;
      await mutateProject(ctx.project.id, (p) =>
        ctx.kind === "worktree"
          ? {
              ...p,
              worktrees: p.worktrees.map((w) =>
                w.id === ctx.worktree.id
                  ? { ...w, sessions: w.sessions.map(stripInitialPrompt) }
                  : w,
              ),
            }
          : { ...p, directSessions: p.directSessions.map(stripInitialPrompt) },
      );
    }

    return reply.send({ ok: true });
  });

  // POST /sessions/:id/resume
  app.post("/sessions/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    // Bug 4 fix: an archived session is displayed read-only by the UI — never
    // let a live agent process spawn/run against a row that's supposed to be
    // retired history.
    if (ctx.session.archivedAt) {
      return reply.status(400).send({ error: "Session is archived — start a new session instead" });
    }

    const { project, session } = ctx;
    const isWorktreeSession = ctx.kind === "worktree";
    const worktree = isWorktreeSession ? ctx.worktree : undefined;

    // Determine working directory
    const cwd = isWorktreeSession
      ? worktreePath(project.id, worktree!.id)
      : project.absolutePath;

    // Guard against a resume racing an already-live pane/pty (double-click,
    // or a resume firing while the create-time spawn is still in flight).
    // Without this, the agent branch below calls spawnSession/spawnSessionFromArgv,
    // which unconditionally kill any existing tmux pane for this session
    // (killStaleTmuxSession in spawn.ts) — so a second resume can tear down a
    // pane that already has a real prompt/conversation running and replace it
    // with a blank one. If something is already alive, just report current
    // state instead of respawning.
    const alreadyRunning = session.useTmux
      ? await hasSession(session.tmuxName)
      : !!directPtyRegistry.get(id);
    if (alreadyRunning) {
      return reply.send(serializeSession(
        isWorktreeSession ? worktree!.id : null,
        project.id,
        session,
      ));
    }

    let restoredFromHistory = false;

    // If the session is an agent type, ask plugin for restore strategy
    if (session.type === "agent" && session.modeId) {
      try {
        const modes = await (await import("../routes/modes.js")).loadModes();
        const found = modes.find((m) => m.id === session.modeId);
        // Deleting an in-use mode is allowed — a session resuming after its
        // mode was removed falls back instead of hard-failing the resume.
        // Prefer a live JSON agent's own frozen cli (accurate — captured
        // before the deletion) over the bare "claude" default; this mirrors
        // the same fallback used by the JSON channel's resolveMode.
        const liveAgentForFallback = found ? undefined : jsonAgentRegistry.get(session.id);
        const mode = found ?? {
          id: session.modeId!,
          name: liveAgentForFallback?.getModeName() ?? "(deleted mode)",
          cli: liveAgentForFallback?.getCli() ?? ("claude" as const),
          context: "",
          createdAt: new Date().toISOString(),
        };
        if (!found) {
          console.warn(
            `[resume] mode '${session.modeId}' not found for session ${session.id} — falling back to ${mode.cli} defaults`,
          );
        }

        const plugin = resolvePlugin(mode.cli);

        // Ask plugin for restore argv. `cwd` is the worktree checkout or, for a
        // direct session, project.absolutePath — so direct sessions restore too.
        const restoreArgv = await plugin.getRestoreCommand?.({
          session,
          project,
          cwd,
          model: mode.model,
        });

        if (restoreArgv) {
          // Resume path: spawn from explicit restore argv
          restoredFromHistory = true;

          // Ensure hook script is installed (self-heals legacy sessions without agentChatId)
          if (plugin.setupWorkspaceHooks) {
            await plugin.setupWorkspaceHooks(cwd);
          }

          // Same context object the spawners build — worktree or project-direct.
          const launchCfg = {
            project,
            ctx: resolvedContextOf(project, worktree ?? null),
            session,
            daemonPort: 0,
            ...(mode.model ? { model: mode.model } : {}),
          };
          const env: Record<string, string> = {
            VST_SESSION: session.id,
            VST_SPAWN_TOKEN: session.id,
            // Direct sessions have no worktree — omit rather than fake it.
            ...(worktree ? { VST_WORKTREE: worktree.id } : {}),
            VST_PROJECT: project.id,
            VST_DATA_DIR: `${process.env.HOME ?? "~"}/.vibe-station/projects/${project.id}`,
            VST_DAEMON_URL: `http://127.0.0.1:${(app.server.address() as { port?: number })?.port ?? 7421}`,
            ...plugin.getEnvironment(launchCfg),
          };

          await spawnSessionFromArgv({
            project,
            cwd,
            worktreeId: worktree?.id,
            session,
            argv: restoreArgv,
            env,
            fallbackMs: plugin.getReadySignal().fallbackMs,
          });

          // Capture chat ID for future resumes (self-healing for legacy
          // sessions that don't have one yet). Only fills a GAP — never
          // overwrites an already-known id. `captureChatId` for a CWD-keyed
          // capture source (agy) can otherwise return a DIFFERENT, unrelated
          // session's conversation if one was ever resumed more recently in
          // the same worktree (see agy.ts's chatIdBaselines block comment).
          if (!session.agentChatId) {
            const capturedId = await plugin.captureChatId?.({ session, project, cwd }) ?? null;
            if (capturedId) {
              session.agentChatId = capturedId;
            }
          }
        } else {
          // Fresh launch path: build prompt and spawn normally.
          //
          // Re-deliver the original create-dialog prompt ONLY when no
          // conversation was ever established (`agentChatId` absent). Once a
          // real chat id exists, the session actually ran — replaying the
          // first prompt on every future resume would silently re-issue a
          // stale instruction to an agent that may have finished long ago.
          const replayInitialPrompt = !session.agentChatId && !!session.initialPrompt;
          const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;

          if (isWorktreeSession) {
            const { buildPrompt } = await import("../services/promptBuilder.js");
            const builtPrompt = await buildPrompt({
              project,
              worktree: worktree!,
              modeContext: mode.context,
              ...(replayInitialPrompt ? { userPrompt: session.initialPrompt } : {}),
            });
            await spawnSession({
              project,
              worktree: worktree!,
              session,
              plugin,
              daemonPort,
              systemPrompt: builtPrompt.systemPrompt,
              taskPrompt: builtPrompt.taskPrompt,
              model: mode.model,
            });
          } else {
            const { buildDirectPrompt } = await import("../services/promptBuilder.js");
            const builtPrompt = await buildDirectPrompt({
              project,
              modeContext: mode.context,
              ...(replayInitialPrompt ? { userPrompt: session.initialPrompt } : {}),
            });
            await spawnDirectSession({
              project,
              session,
              plugin,
              daemonPort,
              systemPrompt: builtPrompt.systemPrompt,
              taskPrompt: builtPrompt.taskPrompt,
              model: mode.model,
            });
          }
        }
      } catch (err) {
        return reply.status(500).send({
          error: `Failed to resume session: ${String(err)}`,
        });
      }
    } else {
      // Terminal session — spawn a new shell session
      try {
        if (session.useTmux) {
          await newSession({ name: session.tmuxName, cwd });
        } else {
          const { DirectPtyBackend } = await import("../services/directPty.js");
          await DirectPtyBackend.spawn({
            command: process.env.SHELL ?? "/bin/bash",
            args: [],
            cwd,
            env: { ...process.env as Record<string, string> },
            cols: 80,
            rows: 24,
            sessionId: session.id,
            projectId: project.id,
            worktreeId: isWorktreeSession ? worktree!.id : undefined,
          });
        }
      } catch {
        // Session may already exist; best-effort
      }
    }

    const updatedSession = {
      ...session,
      lifecycle: {
        state: "working" as const,
        lastTransitionAt: new Date().toISOString(),
      },
    };

    if (isWorktreeSession) {
      await mutateProject(project.id, (p) => ({
        ...p,
        worktrees: p.worktrees.map((w) =>
          w.id === worktree!.id
            ? {
                ...w,
                sessions: w.sessions.map((s) => (s.id === id ? updatedSession : s)),
              }
            : w,
        ),
      }));
    } else {
      await mutateProject(project.id, (p) => ({
        ...p,
        directSessions: p.directSessions.map((s) => (s.id === id ? updatedSession : s)),
      }));
    }

    broadcastAll({
      type: "session:resumed",
      sessionId: id,
      restoredFromHistory,
    });

    return reply.send(serializeSession(
      isWorktreeSession ? worktree!.id : null,
      project.id,
      updatedSession,
    ));
  });

  // POST /sessions/:id/reset   { handoff?: boolean, prompt?: string, modeId?: string }
  // Archive the current session and spawn a fresh one in its place — same tab
  // position (isMain/sortOrder/worktreeId inherited), same name unless a new
  // prompt re-derives it (Decision 2/4/5/6/7). Optionally switches mode/CLI
  // (reset-with-mode-switch Decision 1) — absent `modeId` keeps today's
  // behavior exactly (reuse the outgoing session's mode).
  app.post("/sessions/:id/reset", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ResetBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    }
    const { handoff, prompt, handoffText: handoffTextFromBody, modeId: requestedModeId } = parsed.data;

    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    const { session, project } = ctx;
    if (session.type !== "agent") {
      return reply.status(400).send({ error: "Reset only applies to agent sessions" });
    }
    if (session.archivedAt) {
      return reply.status(400).send({ error: "Session already archived" });
    }

    // Bug fix: a session whose mode was deleted must fail loudly here, not
    // silently archive the old session with no replacement ever spawned (the
    // old behavior — the spawn block further down was gated on `if (mode)`
    // with no error path). Validate BEFORE archiving/spawning anything, and
    // before wasting up to 60s on a handoff turn we'd throw away anyway.
    if (!session.modeId) {
      return reply.status(400).send({ error: "Session has no mode; cannot reset" });
    }
    const { resolveModeId, jsonUnsupportedCli, loadModes } = await import("../routes/modes.js");
    const modes = await loadModes();
    const mode = modes.find((m) => m.id === session.modeId);
    if (!mode) {
      return reply.status(400).send({ error: `Mode '${session.modeId}' not found` });
    }

    // reset-with-mode-switch, Decision 1: resolve + validate the REQUESTED
    // mode (id or name, same convention as session-create's --mode) before
    // any teardown — a typo'd/unknown mode must not archive the old session
    // with nothing to replace it. Falls back to the outgoing session's own
    // (already-validated) mode when no override was given.
    let effectiveModeId = session.modeId;
    if (requestedModeId) {
      let resolvedId: string;
      try {
        resolvedId = await resolveModeId(requestedModeId);
      } catch {
        return reply.status(400).send({ error: `Mode '${requestedModeId}' not found` });
      }
      const requestedMode = modes.find((m) => m.id === resolvedId);
      if (!requestedMode) {
        return reply.status(400).send({ error: `Mode '${requestedModeId}' not found` });
      }
      effectiveModeId = resolvedId;
    }

    // Direct delivery (Decision 1): `--handoff-file` reads the summary locally via the CLI and
    // sends it here as `handoffText`, bypassing paste+poll (and any filesystem lookup) entirely.
    // Only fall back to the live paste+poll turn when no direct text was given.
    let handoffText: string | null = handoffTextFromBody ?? null;
    if (handoffText == null && handoff) {
      const { runHandoffTurn, readHandoffFileOrNull } = await import("../services/handoff.js");
      const handoffPath = join(tmpdir(), `vst-handoff-${randomBytes(6).toString("hex")}.md`);
      const ok = await runHandoffTurn(session, { timeoutMs: 60_000, handoffPath });
      handoffText = ok ? await readHandoffFileOrNull(handoffPath) : null;
    }

    // Kill the process/pane BEFORE detaching WS streams — order doesn't
    // matter for correctness here (both are idempotent/best-effort against an
    // already-dead runtime), but this mirrors DELETE's existing teardown order.
    await releaseSessionRuntime(session, { clearAttachments: false });
    await forceCloseSessionStreams(session.id);

    // Name: keep the old name UNLESS an explicit new prompt was given.
    const newName = prompt ? slugifyPrompt(prompt) || session.name : session.name;
    // Prompt: never the ORIGINAL creation prompt. handoff summary + explicit
    // prompt combine when both are given (Decision 7 — least information-losing
    // default for an explicitly open question).
    const newInitialPrompt = [handoffText, prompt].filter(Boolean).join("\n\n---\n\n") || undefined;

    const scopeId = ctx.kind === "worktree" ? ctx.worktree.id : ctx.project.id;
    const newId = generateSessionId(scopeId, "agent");

    // reset-with-mode-switch, Decision 2: a session switching INTO a mode
    // whose CLI can't do JSON can't keep a "json" channel — silently
    // downgrade to a normal tmux terminal rather than erroring, since
    // "give me this CLI" implies "in whatever channel it can actually run".
    // Every other combination (channel already non-json, or the new CLI
    // also supports json) keeps today's behavior unchanged. Only checks
    // `jsonUnsupportedCli` when the channel is actually json — no point
    // paying for that lookup on the (much more common) non-json reset path.
    const wantsJson = session.channel === "json";
    const downgradeToTmux = wantsJson && (await jsonUnsupportedCli(effectiveModeId)) !== null;
    const isJsonChannel = wantsJson && !downgradeToTmux;
    const newChannel = downgradeToTmux ? "tmux" : session.channel;
    const newUseTmux = downgradeToTmux ? true : session.useTmux;

    const newSession: SessionRecord = {
      id: newId,
      worktreeId: session.worktreeId,
      projectId: session.projectId,
      isMain: session.isMain,
      sortOrder: session.sortOrder,
      type: "agent",
      modeId: effectiveModeId,
      name: newName,
      ...(prompt ? { nameSource: "auto" as const } : session.nameSource ? { nameSource: session.nameSource } : {}),
      tmuxName: tmuxNameForSession(newId),
      useTmux: newUseTmux,
      channel: newChannel,
      lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
      ...(newInitialPrompt ? { initialPrompt: newInitialPrompt } : {}),
      ...(isJsonChannel
        ? {
            transcriptRef: {
              kind: "vst-json" as const,
              path: join(
                ctx.kind === "worktree" ? sessionDataDir(project.id, ctx.worktree.id, newId) : directSessionDataDir(project.id, newId),
                "messages.jsonl",
              ),
            },
          }
        : {}),
    };

    // Risk #2 (Phase 4.4): archiving the old row and appending the
    // replacement happen in this SAME mutateProject call, so a worktree never
    // actually has zero live main sessions in persisted state — there's no
    // window where a concurrent reader could observe the worktree with no
    // main session at all. Every `.find(s => s.isMain)` call site in the
    // codebase (routes/worktrees.ts's serializeWorktree, web-ui's
    // TabsStrip/useWorkspaceUrlSync) already uses optional chaining / treats
    // "not found" as a valid state (falls back to null / disables the
    // affected action), so even a hypothetical transient gap would be safe.
    const archivedAt = new Date().toISOString();
    await mutateProject(project.id, (p) => {
      // Bug 3 fix: the archived row's `isMain` must be explicitly cleared, not
      // just left as-is — the NEW row already inherits `isMain` above, and with
      // no unique/partial index preventing two `isMain=1` rows per worktree,
      // leaving the old row's flag set makes `w.sessions.find(s => s.isMain)`
      // (mainSessionId, TabsStrip's `closeable`, DELETE's "cannot delete main"
      // guard) resolve to the dead archived row instead of the live new one —
      // a permanent unclosable dead "main" tab.
      const archiveSession = (s: SessionRecord): SessionRecord =>
        s.id === session.id
          ? { ...s, archivedAt, handoffSummary: handoffText, isMain: false, supersededBy: newId }
          : s;
      if (ctx.kind === "worktree") {
        return {
          ...p,
          worktrees: p.worktrees.map((w) =>
            w.id === ctx.worktree.id
              ? { ...w, sessions: [...w.sessions.map(archiveSession), newSession] }
              : w,
          ),
        };
      }
      return { ...p, directSessions: [...p.directSessions.map(archiveSession), newSession] };
    });

    const wtIdForSerialize = ctx.kind === "worktree" ? ctx.worktree.id : null;
    broadcastAll({ type: "session:updated", sessionId: session.id, archivedAt, supersededBy: newId });
    broadcastAll({
      type: "session:created",
      sessionId: newId,
      projectId: project.id,
      worktreeId: wtIdForSerialize,
      sessionType: "agent",
      mode: newSession.modeId,
      snapshot: serializeSession(wtIdForSerialize, project.id, newSession),
    });

    // Spawn the replacement session's runtime through the SAME channel-aware,
    // guarded helper session creation uses (Bug 1/2 fix) — never a raw
    // unguarded spawnSession/spawnDirectSession call. `effectiveModeId` was
    // already resolved and validated to exist above (either the requested
    // override or the outgoing session's own mode). Using `session.modeId`
    // here instead would be the exact bug reset-with-mode-switch exists to
    // avoid: the stored record would show the new mode while the spawned
    // process still ran the old CLI.
    const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;
    void spawnNewSessionForChannel({
      project,
      worktree: ctx.kind === "worktree" ? ctx.worktree : undefined,
      session: newSession,
      modeId: effectiveModeId,
      prompt: newInitialPrompt,
      daemonPort,
    });

    return reply.send({ ok: true, archivedSessionId: session.id, newSessionId: newId });
  });

  // POST /sessions/:id/handoff — write-only: runs the handoff turn (Decision 1)
  // but does NOT archive or respawn, unlike reset's --handoff option above.
  app.post("/sessions/:id/handoff", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    if (ctx.session.type !== "agent") {
      return reply.status(400).send({ error: "Handoff only applies to agent sessions" });
    }

    // No archivedAt guard here (unlike reset) — a standalone handoff summary is
    // still meaningful to request even after a session is archived (read-only history).
    const { runHandoffTurn, readHandoffFileOrNull } = await import("../services/handoff.js"); // matches reset's cycle-avoidance import
    const handoffPath = join(tmpdir(), `vst-handoff-${randomBytes(6).toString("hex")}.md`);
    const ok = await runHandoffTurn(ctx.session, { timeoutMs: 60_000, handoffPath });
    const handoffSummary = ok ? await readHandoffFileOrNull(handoffPath) : null;

    return reply.send({ ok: true, handoffSummary });
  });

  // POST /sessions/:id/input
  app.post("/sessions/:id/input", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const result = InputBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Validation error", details: result.error.issues });
    }
    const { data, sendEnter = false } = result.data;
    const { session } = ctx;

    if (!session.useTmux) {
      const stream = directPtyRegistry.get(id);
      if (!stream) {
        return reply.status(409).send({ error: "Session not running" });
      }
      stream.write(data + (sendEnter ? "\r" : ""));
      return reply.send({ ok: true });
    }

    const bufferId = `_vst_send-${id}`;
    try {
      // Paste the message on its own — pasteBuffer wraps it in bracketed-paste
      // markers, so any newline embedded in the payload is delivered as literal
      // text inside the input box, not as an Enter keystroke (see pasteBuffer's
      // doc comment in tmux.ts). Submitting therefore requires a *separate*
      // send-keys "Enter" after the paste completes, not a trailing "\n" baked
      // into the pasted data.
      await pasteBuffer(session.tmuxName, bufferId, data);
      if (sendEnter) {
        // Matches the paste-then-submit convention already used in spawn.ts.
        await sendKeys(session.tmuxName, "", true);
      }
    } catch (err) {
      return reply.status(500).send({ error: `Failed to send input: ${String(err)}` });
    }

    return reply.send({ ok: true });
  });

  // --- JSON agent chat (Decision 8/12) ---

  // POST /sessions/:id/chat — enqueue a user turn. Always accepted (never 409):
  // queued behind any running turn (FIFO). Returns 202 { turnId, queuePosition }.
  app.post("/sessions/:id/chat", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    }
    const { message, attachmentIds } = parsed.data;

    // Bug 4 fix: an archived session is displayed read-only by the UI — never
    // let a chat turn spawn/run a live agent process against it.
    const preChatCtx = findSessionContext(id);
    if (!preChatCtx) return reply.status(404).send({ error: `Session '${id}' not found` });
    if (preChatCtx.session.archivedAt) {
      return reply.status(400).send({ error: "Session is archived — start a new session instead" });
    }

    // Resolve attachment ids to Attachment records (Decision 5).
    const attachments: Attachment[] = [];
    for (const uploadId of attachmentIds ?? []) {
      const att = getAttachment(id, uploadId);
      if (!att) {
        return reply.status(400).send({ error: `Attachment '${uploadId}' not found` });
      }
      attachments.push(att);
    }

    const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;
    let res;
    try {
      res = await enqueueChatTurn({ sessionId: id, message, attachments, daemonPort });
    } catch (err) {
      return reply.status(500).send({ error: `Failed to enqueue turn: ${String(err)}` });
    }
    if (!res.ok) {
      const status = res.reason === "not_found" ? 404 : 400;
      return reply.status(status).send({ error: res.message });
    }

    // Mark the session working while the turn runs (JSON lifecycle, Decision 11).
    const ctx = findJsonSessionContext(id);
    if (ctx) {
      await persistLifecycleState(ctx.project.id, ctx.worktree?.id, id, "working");
    }

    return reply.status(202).send(res.result);
  });

  // POST /sessions/:id/chat/stop — abort the ACTIVE turn, keep queued turns
  // (Decision 8/13). No-op (200) when only queued turns exist; 409 when no JSON
  // agent has ever run for this session.
  app.post("/sessions/:id/chat/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findJsonSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    const agent = jsonAgentRegistry.get(id);
    if (!agent) return reply.status(409).send({ error: "No active turn" });
    agent.stopActiveTurn();
    return reply.send({ ok: true });
  });

  // DELETE /sessions/:id/chat/queue/:turnId — cancel ONE queued (not-yet-started) turn.
  app.delete("/sessions/:id/chat/queue/:turnId", async (req, reply) => {
    const { id, turnId } = req.params as { id: string; turnId: string };
    const ctx = findJsonSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    const agent = jsonAgentRegistry.get(id);
    const removed = agent?.cancelQueuedTurn(turnId) ?? false;
    if (!removed) return reply.status(404).send({ error: `Queued turn '${turnId}' not found` });
    return reply.send({ ok: true });
  });

  // POST …/chat/queue/:turnId/edit — withdraw a queued turn into the editing hold
  // (queue-controls). Returns its raw content + original queue index. Re-editing
  // an already-held turn re-acquires it (recovery, A5). 404 when not queued/held.
  app.post("/sessions/:id/chat/queue/:turnId/edit", async (req, reply) => {
    const { id, turnId } = req.params as { id: string; turnId: string };
    const ctx = findJsonSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    const agent = jsonAgentRegistry.get(id);
    const res = agent?.beginEditQueuedTurn(turnId) ?? "not_queued";
    if (res === "not_queued") return reply.status(404).send({ error: "not_queued" });
    return reply.send({ turnId, ...res });
  });

  // POST …/chat/queue/:turnId/resubmit — re-enqueue a held turn (queue-controls).
  // `edited:true` overwrites text/attachments + emits a superseding user event;
  // `edited:false` restores it unchanged. 404 when the turn isn't held.
  app.post("/sessions/:id/chat/queue/:turnId/resubmit", async (req, reply) => {
    const { id, turnId } = req.params as { id: string; turnId: string };
    const parsed = ResubmitBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    }
    const ctx = findJsonSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    const agent = jsonAgentRegistry.get(id);
    if (!agent) return reply.status(404).send({ error: "not_editing" });

    // Resolve attachment ids only when editing (Decision 5 / A11).
    const attachments: Attachment[] = [];
    if (parsed.data.edited) {
      for (const uploadId of parsed.data.attachmentIds ?? []) {
        const att = getAttachment(id, uploadId);
        if (!att) return reply.status(400).send({ error: `Attachment '${uploadId}' not found` });
        attachments.push(att);
      }
    }

    const result = agent.resubmitQueuedTurn(turnId, {
      edited: parsed.data.edited,
      ...(parsed.data.edited ? { message: parsed.data.message ?? "", attachments } : {}),
    });
    if (result === "not_editing") return reply.status(404).send({ error: "not_editing" });

    // Drain may have persisted `idle` while the turn was held (R17) — the
    // re-enqueued turn will run, so re-flip the lifecycle to working (A4).
    await persistLifecycleState(ctx.project.id, ctx.worktree?.id, id, "working");
    return reply.send({ ok: true, turnId });
  });

  // POST …/chat/queue/:turnId/promote — "Send now": preempt. Jumps the target to
  // the front AND aborts the active turn so it runs next; the aborted turn is
  // dropped (not re-queued).
  app.post("/sessions/:id/chat/queue/:turnId/promote", async (req, reply) => {
    const { id, turnId } = req.params as { id: string; turnId: string };
    const ctx = findJsonSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    const agent = jsonAgentRegistry.get(id);
    const result = agent?.promoteQueuedTurn(turnId) ?? "not_queued";
    if (result === "not_queued") return reply.status(404).send({ error: "not_queued" });
    return reply.send({ ok: true, turnId });
  });

  // POST …/chat/fork — edit an already-ANSWERED turn → fork (P4, R3.1–R3.6).
  // Truncates the branch after turn N (rows marked superseded, not deleted, R3.3)
  // and re-runs the edited message from the fork point on a NEW harness session
  // (claude `--fork-session`). claude-only at launch (R3.5) — gated on the plugin
  // exposing `getForkCommand`; other CLIs 400 (their replay fallback is deferred).
  // Broadcasts the fork so other tabs drop the superseded turns and re-sync (R3.6).
  app.post("/sessions/:id/chat/fork", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ForkBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    }
    const { turnId, message, attachmentIds } = parsed.data;

    const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;
    const resolved = await resolveJsonAgent(id, daemonPort);
    if (!resolved.ok) {
      return reply.status(resolved.reason === "not_found" ? 404 : 400).send({ error: resolved.message });
    }
    const { agent, mode } = resolved;

    // R3.5 — fork is claude-only at launch. Gate on the plugin's fork capability
    // (getForkCommand); non-claude CLIs are blocked until their at-rest replay
    // fallback ships (deferred).
    const plugin = resolvePlugin(mode.cli);
    if (!plugin.getForkCommand) {
      return reply.status(400).send({ error: `${mode.cli} does not support forking (edit a sent message)` });
    }

    // Resolve attachment ids → Attachment records (Decision 5).
    const attachments: Attachment[] = [];
    for (const uploadId of attachmentIds ?? []) {
      const att = getAttachment(id, uploadId);
      if (!att) return reply.status(400).send({ error: `Attachment '${uploadId}' not found` });
      attachments.push(att);
    }

    const res = agent.forkTurn({
      turnId,
      message,
      ...(attachments.length ? { attachments } : {}),
    });
    if (res === "not_found") return reply.status(404).send({ error: `Turn '${turnId}' not found` });

    // The fork will run — flip lifecycle to working (JSON lifecycle, Decision 11).
    const ctx = findJsonSessionContext(id);
    if (ctx) await persistLifecycleState(ctx.project.id, ctx.worktree?.id, id, "working");

    // Mirror the fork to other open tabs (R3.6): they drop the superseded turns
    // and re-sync from the new branch head (the new user event streams live).
    broadcastAll({ type: "session:fork", sessionId: id, supersededTurnIds: res.supersededTurnIds });
    return reply.status(202).send({ ok: true, turnId: res.turnId });
  });

  // PATCH …/chat/model — live-switch the session's model (status-bar switcher).
  // `model: null` clears the override back to the mode default. Applies to the
  // NEXT spawned turn (runOneTurn reads requestedModel at spawn time); never
  // interrupts a running turn.
  app.patch("/sessions/:id/chat/model", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ model: z.string().trim().min(1).max(100).nullable() })
      .safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid model" });

    // `resolveJsonAgent` lazily re-creates a released JsonAgentSession (and
    // reopens its SQLite handles). For a session the user marked `done` that
    // would resurrect the very resources "mark as done" freed — without even
    // moving the session out of `done`. Refuse instead; sending a message is
    // the deliberate way to bring a done session back.
    const modelCtx = findSessionContext(id);
    if (modelCtx?.session.lifecycle.state === "done") {
      return reply.status(409).send({
        error: "Session is done — send a message to resume it before switching model.",
      });
    }

    const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;
    const resolved = await resolveJsonAgent(id, daemonPort);
    if (!resolved.ok) {
      return reply.status(resolved.reason === "not_found" ? 404 : 400).send({ error: resolved.message });
    }
    const { agent, mode } = resolved;

    // Soft validation: when the CLI's model list is available, reject an unknown
    // model (agy hard-fails every subsequent turn on a bad --model). If the list
    // can't be fetched, accept free text (mirrors the ModelPicker fallback).
    if (parsed.data.model) {
      const list = await resolveCliModels(mode.cli);
      if (!list.error && list.models.length > 0 && !list.models.includes(parsed.data.model)) {
        return reply.status(400).send({ error: `Unknown model '${parsed.data.model}' for ${mode.cli}` });
      }
    }

    await agent.setModel(parsed.data.model, mode.model);
    return reply.send({ ok: true, model: parsed.data.model ?? mode.model ?? null });
  });

  // Spawn the tmux/pty process for an EXISTING agent session (worktree OR
  // direct), resuming its `agentChatId` when one exists (P3 json→tty,
  // R1.2/R1.3). Reuses the same restore primitives as POST /resume —
  // `getRestoreCommand` → `spawnSessionFromArgv` — with a fresh-launch
  // fallback for an empty session (no `agentChatId`, J12). `worktree` is
  // `undefined` for a direct (non-worktree) session — mirrors POST /resume's
  // `isWorktreeSession` branching so direct sessions restore too (R1.5 no
  // longer disables the toggle for them). It does NOT reserve a slot or
  // create a record (no create-time side effects).
  async function spawnTtyForAgent(opts: {
    project: ProjectRecord;
    worktree?: WorktreeRecord;
    session: SessionRecord;
    plugin: AgentPlugin;
    model?: string;
    context?: string;
  }): Promise<void> {
    const { project, worktree, session, plugin, model, context } = opts;
    const cwd = worktree ? worktreePath(project.id, worktree.id) : project.absolutePath;
    const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;

    const restoreArgv = await plugin.getRestoreCommand?.({
      session,
      project,
      cwd,
      ...(model ? { model } : {}),
    });

    if (restoreArgv) {
      // Resume path — same as POST /resume: self-heal hooks, then spawn the argv.
      if (plugin.setupWorkspaceHooks) await plugin.setupWorkspaceHooks(cwd);
      const launchCfg = {
        project,
        ctx: resolvedContextOf(project, worktree ?? null),
        session,
        daemonPort: 0,
        ...(model ? { model } : {}),
      };
      const env: Record<string, string> = {
        VST_SESSION: session.id,
        VST_SPAWN_TOKEN: session.id,
        // Direct sessions have no worktree — omit rather than fake it.
        ...(worktree ? { VST_WORKTREE: worktree.id } : {}),
        VST_PROJECT: project.id,
        VST_DATA_DIR: `${process.env.HOME ?? "~"}/.vibe-station/projects/${project.id}`,
        VST_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
        ...plugin.getEnvironment(launchCfg),
      };
      await spawnSessionFromArgv({
        project,
        cwd,
        worktreeId: worktree?.id,
        session,
        argv: restoreArgv,
        env,
        fallbackMs: plugin.getReadySignal().fallbackMs,
      });
      // Self-heal only — never overwrite an already-known id (same reasoning
      // as the /resume capture above: a CWD-keyed capture source can return
      // a different session's conversation).
      if (!session.agentChatId) {
        const capturedId = (await plugin.captureChatId?.({ session, project, cwd })) ?? null;
        if (capturedId) session.agentChatId = capturedId;
      }
    } else if (worktree) {
      // Fresh launch — an empty session with nothing to resume (J12).
      const { buildPrompt } = await import("../services/promptBuilder.js");
      const built = await buildPrompt({
        project,
        worktree,
        ...(context ? { modeContext: context } : {}),
      });
      await spawnSession({
        project,
        worktree,
        session,
        plugin,
        daemonPort,
        systemPrompt: built.systemPrompt,
        taskPrompt: built.taskPrompt,
        ...(model ? { model } : {}),
      });
    } else {
      // Fresh launch — direct-session counterpart of the branch above.
      const { buildDirectPrompt } = await import("../services/promptBuilder.js");
      const built = await buildDirectPrompt({
        project,
        ...(context ? { modeContext: context } : {}),
      });
      const { spawnDirectSession } = await import("../services/spawn.js");
      await spawnDirectSession({
        project,
        session,
        plugin,
        daemonPort,
        systemPrompt: built.systemPrompt,
        taskPrompt: built.taskPrompt,
        ...(model ? { model } : {}),
      });
    }
  }

  // PATCH …/sessions/:id/channel — live JSON↔terminal toggle (P3, R1.1–R1.7).
  // Idle-gated (409 when a turn is active/queued/held for edit). Supports BOTH
  // worktree-backed and direct/project-scoped sessions (R1.5 — direct sessions
  // restore the same way POST /resume already does, via project.absolutePath
  // as cwd). Works for EVERY agent CLI in both directions: json→tty spawns the
  // TTY resuming the same agentChatId;
  // tty→json tears the TTY down and re-establishes the JSON session. The
  // terminal-phase turns are backfilled via the P2 importer ONLY for CLIs that
  // ship a native-history importer (claude/opencode); CLIs without one
  // (cursor/agy) skip the backfill and return lossily (`historyImported:false`)
  // — the model still has those turns via --resume. The switch is mirrored to
  // other open tabs (R1.7).
  app.patch("/sessions/:id/channel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ channel: z.enum(["json", "tmux", "pty"]) }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid channel" });
    const target = parsed.data.channel;

    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    const { project, session } = ctx;

    if (session.type !== "agent") {
      return reply.status(400).send({ error: "Only agent sessions can switch channel" });
    }

    const current = sessionChannel(session);
    if (current === target) return reply.send({ ok: true, channel: current }); // idempotent no-op

    // R1.5 — direct (non-worktree) sessions restore via project.absolutePath,
    // same as POST /resume; `worktree` is undefined for them.
    const worktree = ctx.kind === "worktree" ? ctx.worktree : undefined;

    // Resolve mode → plugin. Deleting an in-use mode is allowed, so a missing
    // mode falls back instead of hard-failing the toggle: prefer the cli a
    // live JSON agent already captured at construction time (accurate — it
    // predates the deletion), else default to claude with no saved model/context.
    const modes = await (await import("../routes/modes.js")).loadModes();
    const found = session.modeId ? modes.find((m) => m.id === session.modeId) : undefined;
    const liveAgentForFallback = found ? undefined : jsonAgentRegistry.get(id);
    const mode = found ?? {
      id: session.modeId ?? "",
      name: liveAgentForFallback?.getModeName() ?? "(deleted mode)",
      cli: liveAgentForFallback?.getCli() ?? ("claude" as const),
      context: "",
      createdAt: new Date().toISOString(),
    };
    if (!found) {
      console.warn(
        `[channel-toggle] mode '${session.modeId}' not found for session ${session.id} — falling back to ${mode.cli} defaults`,
      );
    }
    const plugin = resolvePlugin(mode.cli);

    const fromJson = current === "json";
    const toJson = target === "json";
    const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;

    // R1.1 idle gate — only a live JSON session has a turn queue/holds to protect.
    if (fromJson) {
      const agent = jsonAgentRegistry.get(id);
      if (agent && !agent.isIdleForToggle) {
        return reply.status(409).send({ error: "not_idle" });
      }
    }

    // Compute the record's target channel + `useTmux` invariant (R1.2) up front:
    // the json→tty spawn below reads `session.useTmux`/`session.tmuxName`, so the
    // flip must land BEFORE the spawn (not after) or the TTY comes up on the
    // stale JSON placeholder.
    const { channel: newChannel, useTmux: newUseTmux } = channelTransition(target);
    // JSON sessions keep the `__direct__-<id>` placeholder tmux name; a terminal
    // needs a REAL window name — derived from the session's own id (Decision 1),
    // same as at session-create.
    const jsonTmuxName = `__direct__-${session.id}`;
    const ttyTmuxName = newUseTmux ? tmuxNameForSession(session.id) : jsonTmuxName;

    try {
      if (fromJson) {
        // json → tty: detach the in-memory JSON session (idle-gated, so this only
        // tears down bookkeeping), then spawn the TTY resuming the agentChatId.
        // dispose() closes the SQLite handle so a repeated json→tty→json cycle
        // doesn't accumulate one open store per toggle.
        const jsonAgentToClose = jsonAgentRegistry.get(id);
        jsonAgentRegistry.delete(id);
        await jsonAgentToClose?.release();
        // Allocate the real terminal tmux name + flip the useTmux/channel
        // invariant BEFORE spawning so the pane attaches to a live window.
        session.tmuxName = ttyTmuxName;
        session.channel = newChannel;
        session.useTmux = newUseTmux;
        await spawnTtyForAgent({
          project,
          ...(worktree ? { worktree } : {}),
          session,
          plugin,
          ...(mode.model ? { model: mode.model } : {}),
          ...(mode.context ? { context: mode.context } : {}),
        });
      } else {
        // tty → json: tear the TTY down (reuse the DELETE teardown primitives).
        // Read `session.useTmux` BEFORE flipping it (still the terminal value here).
        if (session.useTmux) {
          try {
            await killSession(session.tmuxName);
          } catch {
            // best-effort
          }
        } else {
          directPtyRegistry.get(id)?.kill?.();
        }
        // This teardown isn't a poller-detected exit, so the poller's own
        // idle-hash cleanup never runs — clear it explicitly. Otherwise a
        // STALE hash can survive into a LATER json→tty toggle and, if the new
        // pane's first captured lines happen to hash identical to the old
        // session's (plausible — same CLI splash), flip the fresh session to
        // "idle" one tick after this handler marks it "working".
        clearIdleTracking(id);
        // Self-heal `agentChatId` against the CLI's own live state (agy —
        // see `refreshChatIdOnToggle`'s doc comment / the chatIdBaselines
        // block in agy.ts). Unlike the resume-path captures above, this
        // INTENTIONALLY overwrites even an already-set id: the whole point
        // is correcting a possibly-wrong value with the freshest truth,
        // captured at the one moment it's most trustworthy — right after a
        // real, live conversation the user was just using. No-ops for
        // plugins that don't implement it (claude/opencode/cursor already
        // capture reliably and shouldn't be second-guessed here).
        const refreshedId = (await plugin.refreshChatIdOnToggle?.({ session, project, worktree })) ?? null;
        if (refreshedId) session.agentChatId = refreshedId;
        // Reset the tmux name back to the JSON `__direct__` placeholder so the
        // record is consistent for JSON mode, then flip the invariant.
        session.tmuxName = jsonTmuxName;
        session.channel = newChannel;
        session.useTmux = newUseTmux;
      }
    } catch (err) {
      return reply.status(500).send({ error: `Failed to switch channel: ${String(err)}` });
    }

    // Persist the flipped channel + `useTmux` invariant + the new tmuxName,
    // along with any agentChatId the json→tty restore may have self-healed.
    //
    // json→tty ALSO resets `lifecycle` to "working", mirroring `/resume`
    // (sessions.ts ~L913-919). Without this, a record left at "exited" from
    // any PRIOR real tmux death stays "exited" forever: the lifecycle poller
    // (services/lifecycle.ts ~L185) explicitly refuses to touch a session
    // whose state isn't already "working"/"idle" — spawning a brand-new,
    // genuinely live tmux window does not by itself clear a stale "exited"
    // record, so the terminal pane keeps showing the "Session exited /
    // Resume" banner over a terminal that is actually live and working.
    const patchToggledSession = (s: SessionRecord): SessionRecord =>
      s.id === id
        ? {
            ...s,
            channel: newChannel,
            useTmux: newUseTmux,
            tmuxName: session.tmuxName,
            ...(session.agentChatId ? { agentChatId: session.agentChatId } : {}),
            ...(fromJson
              ? { lifecycle: { state: "working" as const, lastTransitionAt: new Date().toISOString() } }
              : {}),
          }
        : s;
    await mutateProject(project.id, (p) =>
      worktree
        ? {
            ...p,
            worktrees: p.worktrees.map((w) =>
              w.id === worktree.id ? { ...w, sessions: w.sessions.map(patchToggledSession) } : w,
            ),
          }
        : { ...p, directSessions: p.directSessions.map(patchToggledSession) },
    );

    // Compute the fresh meta to mirror to other tabs.
    let meta: SessionMeta;
    // Whether terminal-phase turns were backfilled into the JSON transcript.
    // Only true on a tty→json switch for a CLI that ships a native-history
    // importer; cursor/agy skip the backfill (lossy return), and json→tty never
    // imports.
    let historyImported = false;
    if (toJson) {
      // tty → json: register a fresh JSON session (reads the now-json record) and
      // backfill the terminal-phase turns from the native store (R1.4) — but only
      // for CLIs with a native-history importer. Without one (cursor/agy) we skip
      // the backfill and return lossily; the agent still has those turns via
      // --resume, they just won't appear in the JSON view.
      const resolved = await resolveJsonAgent(id, daemonPort);
      if (resolved.ok) {
        if (hasNativeHistoryImporter(mode.cli)) {
          await resolved.agent.importNativeHistory();
          historyImported = true;
        }
        meta = resolved.agent.getMeta();
      } else {
        meta = {
          sessionId: id,
          channel: newChannel,
          cli: mode.cli,
          ...(mode.id ? { modeId: mode.id } : {}),
          ...(mode.name ? { modeName: mode.name } : {}),
          turnState: "idle",
          queueDepth: 0,
          queuedTurnIds: [],
          editingTurnIds: [],
        };
      }
    } else {
      // json → tty: no live JSON session anymore — synthesize an idle TTY meta.
      meta = {
        sessionId: id,
        channel: newChannel,
        cli: mode.cli,
        ...(mode.id ? { modeId: mode.id } : {}),
        ...(mode.name ? { modeName: mode.name } : {}),
        turnState: "idle",
        queueDepth: 0,
        queuedTurnIds: [],
        editingTurnIds: [],
      };
    }

    // Mirror the switch to every open tab (R1.7): patch the session record (drives
    // the chat/terminal pane flip) + broadcast the fresh meta (status bar).
    broadcastAll({ type: "session:updated", sessionId: id, channel: newChannel });
    broadcastAll({ type: "session:meta", sessionId: id, meta });
    if (fromJson) {
      // Mirrors the `lifecycle` reset in the mutateProject merge above — an
      // already-open tab's TerminalPane only clears its "Session exited /
      // Resume" banner on `session:state`/`session:resumed`
      // (useSubscription.ts ~L44-46, ~L72-76), NOT on `session:updated` or
      // `session:meta`. Without this, a tab open at toggle time keeps
      // showing the stale banner over a genuinely live terminal until its
      // next reconnect/reload.
      broadcastAll({ type: "session:state", sessionId: id, state: "working" });
    }
    return reply.send({ ok: true, channel: newChannel, historyImported });
  });

  // GET /sessions/:id/transcript — bounded normalized history (R2.1–R2.3).
  //   ?beforeSeq=<n>&limit=<n> → keyset "load earlier" page { events, oldestSeq, hasMore }
  //   ?since=<logSeq>          → reconnect delta { events }
  //   (no query)               → tail-N turns { events, oldestSeq, hasMore }
  // `?all=1` returns the whole transcript (guarded "load all" escape hatch, R2.5).
  app.get("/sessions/:id/transcript", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findJsonSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const q = req.query as { beforeSeq?: string; limit?: string; since?: string; all?: string };

    if (q.all === "1" || q.all === "true") {
      return reply.send({ events: readSessionTranscript(ctx) });
    }

    if (q.since !== undefined) {
      const sinceSeq = Number(q.since);
      if (!Number.isFinite(sinceSeq)) return reply.status(400).send({ error: "invalid since" });
      return reply.send({ events: readSessionSince(ctx, sinceSeq) });
    }

    if (q.beforeSeq !== undefined) {
      const beforeSeq = Number(q.beforeSeq);
      const limit = q.limit !== undefined ? Number(q.limit) : 20;
      if (!Number.isFinite(beforeSeq) || !Number.isFinite(limit) || limit <= 0) {
        return reply.status(400).send({ error: "invalid beforeSeq/limit" });
      }
      return reply.send(readSessionPageBefore(ctx, beforeSeq, limit));
    }

    const limit = q.limit !== undefined ? Number(q.limit) : 20;
    if (!Number.isFinite(limit) || limit <= 0) return reply.status(400).send({ error: "invalid limit" });
    return reply.send(readSessionTail(ctx, limit));
  });

  // GET /sessions/:id/meta — latest cross-harness meta (rebuilt from the
  // transcript tail when no live session is registered, Decision 8).
  app.get("/sessions/:id/meta", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findJsonSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;
    return reply.send(await readSessionMeta(ctx, daemonPort));
  });
}
