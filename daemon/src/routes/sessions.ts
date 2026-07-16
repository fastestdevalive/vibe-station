import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAllProjects, getProject, mutateProject } from "../state/project-store.js";
import {
  reserveNextAgentSlot,
  reserveNextTerminalSlot,
  reserveNextDirectSlot,
  buildTmuxName,
  buildDirectTmuxName,
} from "../services/sessionId.js";
import { killSession, newSession, pasteBuffer, capturePane } from "../services/tmux.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { spawnSession, spawnSessionFromArgv, spawnDirectSession } from "../services/spawn.js";
import { resolvedContextOf } from "../services/context.js";
import { cleanupSessionDataDir, cleanupDirectSessionDataDir, worktreePath } from "../services/paths.js";
import { broadcastAll } from "../broadcaster.js";
import { resolvePlugin } from "../agent-plugins/registry.js";
import { resolveUseTmux } from "../services/resolveUseTmux.js";
import { persistLifecycleState } from "../services/lifecycle.js";
import type { SessionRecord, WorktreeRecord, ProjectRecord } from "../types.js";

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
  name: z.string().trim().max(60).optional(),
});

const DirectSessionBody = z.object({
  target: z.literal("direct"),
  projectId: z.string().min(1),
  type: z.enum(["agent", "terminal"]),
  modeId: z.string().min(1).nullish(),
  prompt: z.string().optional(),
  useTmux: z.boolean().optional(),
  name: z.string().trim().max(60).optional(),
});

const CreateSessionBody = z.union([WorktreeSessionBody, DirectSessionBody]);

const InputBody = z.object({
  data: z.string().min(1),
  sendEnter: z.boolean().optional(),
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
    session.lifecycle = { state: "working", lastTransitionAt: new Date().toISOString() };
    await mutateProject(project.id, (p) => ({
      ...p,
      directSessions: p.directSessions.map((s) => (s.id === sessionId ? session : s)),
    }));
    broadcastAll({ type: "session:state", sessionId, state: "working" });
  } catch (err) {
    const reason = String(err);
    session.lifecycle = { state: "exited", lastTransitionAt: new Date().toISOString() };
    await mutateProject(project.id, (p) => ({
      ...p,
      directSessions: p.directSessions.map((s) => (s.id === sessionId ? session : s)),
    }));
    broadcastAll({ type: "session:state", sessionId, state: "exited", reason });
  }
}

function labelForSlot(slot: SessionRecord["slot"], type: SessionRecord["type"]): string {
  if (slot === "m") return "main";
  // Direct sessions use d-prefix slots
  if (String(slot).startsWith("d")) {
    if (type === "agent") return `direct ${String(slot).slice(1)}`;
    return `term ${String(slot).slice(1)}`;
  }
  if (type === "agent") return `agent ${String(slot).slice(1)}`;
  return `term ${String(slot).slice(1)}`;
}

/** Display label: the stored custom/default name when set, else slot-derived. */
function labelForSession(s: SessionRecord): string {
  return s.name && s.name.length > 0 ? s.name : labelForSlot(s.slot, s.type);
}

/** Flatten SessionRecord's nested lifecycle and add UI-required fields (REST + WS snapshot). */
export function serializeSession(worktreeId: string | null, projectId: string, s: SessionRecord) {
  return {
    id: s.id,
    worktreeId,
    projectId,
    slot: s.slot,
    type: s.type,
    modeId: s.modeId ?? null,
    name: s.name ?? null,
    label: labelForSession(s),
    tmuxName: s.tmuxName,
    useTmux: s.useTmux,
    state: s.lifecycle.state,
    lifecycleState: s.lifecycle.state,
    createdAt: s.lifecycle.lastTransitionAt,
    pinnedAt: s.pinnedAt ?? null,
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
    const useTmux = resolveUseTmux(rawUseTmux);

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

      // Reserve direct slot
      const slot = reserveNextDirectSlot(project);
      const tmuxName = useTmux
        ? buildDirectTmuxName(project.prefix, slot)
        : `__direct__-${projectId}-${slot}`;
      const sessionId = `${projectId}-${slot}`;

      // Terminal naming for direct sessions
      let nextDirectSeq: number | undefined;
      let terminalName: string | undefined;
      if (type === "terminal") {
        nextDirectSeq = (project.directSessionSeq ?? 0) + 1;
        const provided = data.name;
        terminalName = provided && provided.length > 0 ? provided : `Terminal ${nextDirectSeq}`;
      }

      const sessionRecord: SessionRecord = {
        id: sessionId,
        slot,
        type,
        modeId: type === "agent" ? (modeId ?? undefined) : undefined,
        name: terminalName,
        tmuxName,
        useTmux,
        lifecycle: {
          state: "not_started",
          lastTransitionAt: new Date().toISOString(),
        },
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
        ...(nextDirectSeq != null ? { directSessionSeq: nextDirectSeq } : {}),
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
        snapshot: serializeSession(null, project.id, sessionRecord),
      });

      // Spawn agent in background
      if (type === "agent" && modeId) {
        const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;
        void runDirectAgentSpawnJob({ project, session: sessionRecord, modeId, prompt, daemonPort });
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

    // Reserve slot
    const slot = type === "agent"
      ? reserveNextAgentSlot(worktree)
      : reserveNextTerminalSlot(worktree);

    const wtNum = parseInt(worktree.id.split("-").at(-1) ?? "1", 10);
    const tmuxName = useTmux ? buildTmuxName(project.prefix, wtNum, slot) : `__direct__-${`${worktreeId}-${slot}`}`;
    const sessionId = `${worktreeId}-${slot}`;

    // Terminal naming: monotonic per-worktree counter (never reused).
    let nextTerminalSeq: number | undefined;
    let terminalName: string | undefined;
    if (type === "terminal") {
      nextTerminalSeq = (worktree.terminalSeq ?? 0) + 1;
      const provided = data.name;
      terminalName = provided && provided.length > 0 ? provided : `Terminal ${nextTerminalSeq}`;
    }

    const sessionRecord: SessionRecord = {
      id: sessionId,
      slot,
      type,
      modeId: type === "agent" ? (modeId ?? undefined) : undefined,
      name: terminalName,
      tmuxName,
      useTmux,
      lifecycle: {
        state: "not_started",
        lastTransitionAt: new Date().toISOString(),
      },
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
      snapshot: serializeSession(worktreeId, project.id, sessionRecord),
    });

    if (type === "agent" && modeId) {
      const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;
      void runAgentSpawnJob({ project, worktree, session: sessionRecord, modeId, prompt, daemonPort });
    }

    return reply.status(201).send(serializeSession(worktreeId, project.id, sessionRecord));
  });

  // DELETE /sessions/:id
  app.delete("/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const { project, session } = ctx;

    // Main session cannot be killed (worktree sessions only)
    if (session.slot === "m") {
      return reply.status(400).send({
        error: "Cannot delete the main session. Use DELETE /worktrees/:id instead.",
      });
    }

    // Kill session (tmux or direct-pty)
    if (!session.useTmux) {
      directPtyRegistry.get(id)?.kill?.();
    } else {
      try {
        await killSession(session.tmuxName);
      } catch {
        // best-effort
      }
    }

    if (ctx.kind === "worktree") {
      // Worktree session: cleanup worktree-scoped data dir
      cleanupSessionDataDir(project.id, ctx.worktree.id, id);
      // Remove from worktree's sessions array
      await mutateProject(project.id, (p) => ({
        ...p,
        worktrees: p.worktrees.map((w) =>
          w.id === ctx.worktree.id
            ? { ...w, sessions: w.sessions.filter((s) => s.id !== id) }
            : w,
        ),
      }));
    } else {
      // Direct session: cleanup project-scoped data dir
      cleanupDirectSessionDataDir(project.id, id);
      // Remove from project's directSessions array
      await mutateProject(project.id, (p) => ({
        ...p,
        directSessions: p.directSessions.filter((s) => s.id !== id),
      }));
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

  // POST /sessions/:id/done — mark an agent session as done (metadata only; no
  // process kill). Terminals have no "done" concept, so reject them.
  app.post("/sessions/:id/done", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    if (ctx.session.type !== "agent") {
      return reply.status(400).send({ error: "Only agent sessions can be marked done." });
    }

    ctx.session.lifecycle = { state: "done", lastTransitionAt: new Date().toISOString() };
    // persistLifecycleState handles both the worktree and direct branches and
    // broadcasts session:state itself.
    await persistLifecycleState(
      ctx.project.id,
      ctx.kind === "worktree" ? ctx.worktree.id : undefined,
      id,
      "done",
    );
    return reply.send({ ok: true });
  });

  // POST /sessions/:id/resume
  app.post("/sessions/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const { project, session } = ctx;
    const isWorktreeSession = ctx.kind === "worktree";
    const worktree = isWorktreeSession ? ctx.worktree : undefined;

    // Determine working directory
    const cwd = isWorktreeSession
      ? worktreePath(project.id, worktree!.id)
      : project.absolutePath;

    let restoredFromHistory = false;

    // If the session is an agent type, ask plugin for restore strategy
    if (session.type === "agent" && session.modeId) {
      try {
        const modes = await (await import("../routes/modes.js")).loadModes();
        const mode = modes.find((m) => m.id === session.modeId);
        if (!mode) {
          throw new Error(`Mode '${session.modeId}' not found`);
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

          // Capture chat ID for future resumes (self-healing for legacy sessions)
          const capturedId = await plugin.captureChatId?.({ session, project, cwd }) ?? null;
          if (capturedId) {
            session.agentChatId = capturedId;
          }
        } else {
          // Fresh launch path: build prompt and spawn normally
          const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;

          if (isWorktreeSession) {
            const { buildPrompt } = await import("../services/promptBuilder.js");
            const builtPrompt = await buildPrompt({
              project,
              worktree: worktree!,
              modeContext: mode.context,
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
      await pasteBuffer(session.tmuxName, bufferId, data + (sendEnter ? "\n" : ""));
    } catch (err) {
      return reply.status(500).send({ error: `Failed to send input: ${String(err)}` });
    }

    return reply.send({ ok: true });
  });
}
