import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAllProjects, getProject, mutateProject } from "../state/project-store.js";
import {
  reserveNextAgentSlot,
  reserveNextTerminalSlot,
  buildTmuxName,
} from "../services/sessionId.js";
import { killSession, newSession, pasteBuffer, capturePane } from "../services/tmux.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { spawnSession, spawnSessionFromArgv } from "../services/spawn.js";
import { cleanupSessionDataDir, worktreePath } from "../services/paths.js";
import { notifySession, broadcastAll } from "../broadcaster.js";
import { resolvePlugin } from "../agent-plugins/registry.js";
import { resolveUseTmux } from "../services/resolveUseTmux.js";
import type { SessionRecord, WorktreeRecord, ProjectRecord } from "../types.js";

const CreateSessionBody = z.object({
  worktreeId: z.string().min(1),
  type: z.enum(["agent", "terminal"]),
  modeId: z.string().min(1).nullish(),
  prompt: z.string().optional(),
  useTmux: z.boolean().optional(),
});

const InputBody = z.object({
  data: z.string().min(1),
  sendEnter: z.boolean().optional(),
});

function findSessionContext(
  sessionId: string,
): { project: ProjectRecord; worktree: WorktreeRecord; session: SessionRecord } | null {
  for (const project of getAllProjects()) {
    for (const worktree of project.worktrees) {
      const session = worktree.sessions.find((s) => s.id === sessionId);
      if (session) return { project, worktree, session };
    }
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

function labelForSlot(slot: SessionRecord["slot"], type: SessionRecord["type"]): string {
  if (slot === "m") return "main";
  if (type === "agent") return `agent ${String(slot).slice(1)}`;
  return `term ${String(slot).slice(1)}`;
}

/** Flatten SessionRecord's nested lifecycle and add UI-required fields (REST + WS snapshot). */
export function serializeSession(worktreeId: string, s: SessionRecord) {
  return {
    id: s.id,
    worktreeId,
    slot: s.slot,
    type: s.type,
    modeId: s.modeId ?? null,
    label: labelForSlot(s.slot, s.type),
    tmuxName: s.tmuxName,
    useTmux: s.useTmux,
    state: s.lifecycle.state,
    lifecycleState: s.lifecycle.state,
    createdAt: s.lifecycle.lastTransitionAt,
  };
}

export function registerSessionRoutes(app: FastifyInstance): void {
  // GET /sessions?worktree=:id
  app.get("/sessions", async (req, reply) => {
    const { worktree: wtId } = req.query as { worktree?: string };
    if (wtId) {
      const ctx = findWorktreeContext(wtId);
      if (!ctx) return reply.status(404).send({ error: `Worktree '${wtId}' not found` });
      return reply.send(ctx.worktree.sessions.map((s) => serializeSession(ctx.worktree.id, s)));
    }
    const all = getAllProjects().flatMap((p) =>
      p.worktrees.flatMap((w) => w.sessions.map((s) => serializeSession(w.id, s))),
    );
    return reply.send(all);
  });

  // GET /sessions/:id
  app.get("/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    return reply.send(serializeSession(ctx.worktree.id, ctx.session));
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

  // POST /sessions
  app.post("/sessions", async (req, reply) => {
    const result = CreateSessionBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Validation error", details: result.error.issues });
    }
    const { worktreeId, type, modeId, prompt, useTmux: rawUseTmux } = result.data;
    const useTmux = resolveUseTmux(rawUseTmux);

    if (type === "agent" && !modeId) {
      return reply.status(400).send({ error: "'modeId' is required for agent sessions" });
    }

    const ctx = findWorktreeContext(worktreeId);
    if (!ctx) return reply.status(404).send({ error: `Worktree '${worktreeId}' not found` });

    const { project, worktree } = ctx;

    // Reject if trying to create an 'm' slot directly
    // (main session is created by POST /worktrees only)

    // Reserve slot
    const slot = type === "agent"
      ? reserveNextAgentSlot(worktree)
      : reserveNextTerminalSlot(worktree);

    const wtNum = parseInt(worktree.id.split("-").at(-1) ?? "1", 10);
    const tmuxName = useTmux ? buildTmuxName(project.prefix, wtNum, slot) : `__direct__-${`${worktreeId}-${slot}`}`;
    const sessionId = `${worktreeId}-${slot}`;

    const sessionRecord: SessionRecord = {
      id: sessionId,
      slot,
      type,
      modeId: type === "agent" ? (modeId ?? undefined) : undefined,
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

    // Persist
    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktreeId ? { ...w, sessions: [...w.sessions, sessionRecord] } : w,
      ),
    }));

    // Broadcast and return immediately — agent spawn runs in background.
    // session:created must be broadcastAll, not notifySession — no client has
    // subscribed to a brand-new sessionId yet.
    broadcastAll({
      type: "session:created",
      sessionId,
      worktreeId,
      sessionType: type,
      mode: typeof modeId === "string" ? modeId : undefined,
      snapshot: serializeSession(worktreeId, sessionRecord),
    });

    if (type === "agent" && modeId) {
      const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;
      void runAgentSpawnJob({ project, worktree, session: sessionRecord, modeId, prompt, daemonPort });
    }

    return reply.status(201).send(serializeSession(worktreeId, sessionRecord));
  });

  // DELETE /sessions/:id
  app.delete("/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const { project, worktree, session } = ctx;

    // Main session cannot be killed
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

    // Best-effort cleanup of per-session data dir
    cleanupSessionDataDir(project.id, worktree.id, id);

    // Remove from manifest
    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktree.id
          ? { ...w, sessions: w.sessions.filter((s) => s.id !== id) }
          : w,
      ),
    }));

    notifySession(id, { type: "session:deleted", sessionId: id });
    return reply.send({ ok: true });
  });

  // POST /sessions/:id/resume
  app.post("/sessions/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const { project, worktree, session } = ctx;

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

        // Ask plugin for restore argv
        const restoreArgv = await plugin.getRestoreCommand?.({
          session,
          project,
          worktree,
          model: mode.model,
        });

        if (restoreArgv) {
          // Resume path: spawn from explicit restore argv
          restoredFromHistory = true;
          const wtPath = worktreePath(project.id, worktree.id);

          // Ensure hook script is installed (self-heals legacy sessions without agentChatId)
          if (plugin.setupWorkspaceHooks) {
            await plugin.setupWorkspaceHooks(wtPath);
          }

          const launchCfg = { project, worktree, session, daemonPort: 0 };
          const env: Record<string, string> = {
            VST_SESSION: session.id,
            VST_SPAWN_TOKEN: session.id,
            VST_WORKTREE: worktree.id,
            VST_PROJECT: project.id,
            VST_DATA_DIR: `${process.env.HOME ?? "~"}/.vibe-station/projects/${project.id}`,
            VST_DAEMON_URL: `http://127.0.0.1:${(app.server.address() as { port?: number })?.port ?? 7421}`,
            ...plugin.getEnvironment(launchCfg),
          };

          await spawnSessionFromArgv({
            project,
            worktree,
            session,
            argv: restoreArgv,
            env,
            fallbackMs: plugin.getReadySignal().fallbackMs,
          });

          // Capture chat ID for future resumes (self-healing for legacy sessions)
          const capturedId = await plugin.captureChatId?.({ session, project, worktree }) ?? null;
          if (capturedId) {
            session.agentChatId = capturedId;
          }
        } else {
          // Fresh launch path: build prompt and spawn normally
          const { buildPrompt } = await import("../services/promptBuilder.js");
          const builtPrompt = await buildPrompt({
            project,
            worktree,
            modeContext: mode.context,
          });

          // Get daemon port
          const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;

          // Spawn a fresh session
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
        }
      } catch (err) {
        return reply.status(500).send({
          error: `Failed to resume session: ${String(err)}`,
        });
      }
    } else {
      // Terminal session — spawn a new shell session
      try {
        const { worktreePath: getWtPath } = await import("../services/paths.js");
        const wtPath = getWtPath(project.id, worktree.id);
        if (session.useTmux) {
          await newSession({ name: session.tmuxName, cwd: wtPath });
        } else {
          const { DirectPtyBackend } = await import("../services/directPty.js");
          await DirectPtyBackend.spawn({
            command: process.env.SHELL ?? "/bin/bash",
            args: [],
            cwd: wtPath,
            env: { ...process.env as Record<string, string> },
            cols: 80,
            rows: 24,
            sessionId: session.id,
            projectId: project.id,
            worktreeId: worktree.id,
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

    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktree.id
          ? {
              ...w,
              sessions: w.sessions.map((s) => (s.id === id ? updatedSession : s)),
            }
          : w,
      ),
    }));

    notifySession(id, {
      type: "session:resumed",
      sessionId: id,
      restoredFromHistory,
    });
    return reply.send(serializeSession(worktree.id, updatedSession));
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
