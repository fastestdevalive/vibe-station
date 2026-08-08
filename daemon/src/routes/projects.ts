import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, sep } from "node:path";
import {
  getAllProjects,
  getProject,
  addProject,
  deleteProject,
  mutateProject,
} from "../state/project-store.js";
import { listFiles } from "../services/fileList.js";
import { buildIgnoreMatcher } from "../services/ignoreFilter.js";
import {
  isGitRepo,
  detectDefaultBranch,
  listBranches,
  isGitAvailable,
} from "../services/git.js";
import { runProjectSetup } from "../services/projectSetup.js";
import { validateBranch } from "../services/branchValidator.js";
import { generateProjectPrefix, makeUniquePrefix } from "../services/prefix.js";
import { slugify, isSafeProjectId } from "../services/slugify.js";
import { projectDir, assertSafeToDelete } from "../services/paths.js";
import { readSettings } from "../services/config.js";
import { broadcastAll } from "../broadcaster.js";
import { releaseSessionRuntime } from "../services/sessionRuntime.js";
import type { ProjectRecord, SessionRecord } from "../types.js";

/**
 * Resolve a leading `~` (either exactly `~` or `~/...`) to the user's home
 * dir. Kept local (not shared via services/paths.ts) because some daemon
 * tests mock that module with a partial export set; a self-contained helper
 * here doesn't depend on the mock's shape.
 */
function expandTilde(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith(`~${sep}`) || input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/** Map internal ProjectRecord to API shape consumed by the web UI. */
function serializeProject(p: ProjectRecord) {
  return {
    id: p.id,
    name: p.id,
    path: p.absolutePath,
    prefix: p.prefix,
    isGit: p.isGit,
    defaultBranch: p.defaultBranch,
    createdAt: p.createdAt,
    // Always emit so the client never has to special-case undefined.
    hidden: !!p.hidden,
  };
}

/** Image extensions served directly with the right MIME type (skip UTF-8 path). */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/**
 * Resolve `filePath` inside `root`, rejecting path-traversal escapes.
 * Mirror of worktrees.ts `resolveInsideWorktree` for project-scoped files.
 */
function resolveInsideDir(root: string, filePath: string): string {
  const abs = normalize(join(root, filePath));
  const rootNorm = normalize(root);
  if (abs !== rootNorm && !abs.startsWith(rootNorm + sep)) {
    const err = new Error("Path traversal attempt") as Error & { code: string };
    err.code = "ETRAVERSAL";
    throw err;
  }
  return abs;
}

const CreateProjectBody = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(64).optional(),
  // Constrained to lowercase alphanumerics — `prefix` flows into shell-
  // interpolated `tmux` commands (e.g. `tmux send-keys -t ${tmuxName}`)
  // via session.tmuxName, so any non-alphanumeric byte would be a shell
  // injection vector. Daemon binds to 127.0.0.1 (local-only), but defense
  // in depth.
  prefix: z.string().regex(/^[a-z0-9]{1,6}$/).optional(),
  // When true, run the git-ready setup script (init + .gitignore + initial
  // `main` commit) against the directory after registering it.
  setup: z.boolean().optional(),
});

/** Body for POST /projects/create — create a brand new project directory. */
const CreateNewProjectBody = z.object({
  /** Project name (directory name). */
  name: z.string().min(1).max(64),
  /** Parent directory override (default: settings.defaultProjectsDir). */
  dir: z.string().min(1).optional(),
  /**
   * Optional: start an agent after creating the project.
   * - modeId: required if startAgent is provided
   * - prompt: optional initial prompt
   * - useWorktree: true = create worktree + session, false = direct session (default)
   */
  startAgent: z
    .object({
      modeId: z.string().min(1),
      prompt: z.string().optional(),
      useWorktree: z.boolean().optional(),
      /** Branch name for the worktree (useWorktree only). Default "feature". */
      branch: z.string().optional(),
    })
    .optional(),
});

export function registerProjectRoutes(app: FastifyInstance): void {
  // GET /projects
  // Order oldest-first by `createdAt` (new projects append at the bottom),
  // breaking ties on `id`. The in-memory store is a Map whose iteration
  // order tracks insertion, but daemon-boot load is `Promise.all` over
  // `readdir`, so the same on-disk projects can appear in different orders
  // across restarts. Stable sort here gives clients a deterministic listing.
  app.get("/projects", async (_req, reply) => {
    const sorted = [...getAllProjects()].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    return reply.send(sorted.map(serializeProject));
  });

  // GET /projects/:projectId/branches
  // Lists local git branches for the project's repo plus the detected default
  // branch, so the New Session dialog can offer a real branch picker instead of
  // a hardcoded "main".
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/branches",
    async (req, reply) => {
      const { projectId } = req.params;
      const project = getProject(projectId);
      if (!project) {
        return reply.status(404).send({ error: `Project '${projectId}' not found` });
      }
      // Non-git projects: return empty branches list (no error)
      if (!project.isGit) {
        return reply.send({ branches: [], defaultBranch: null });
      }
      const branches = await listBranches(project.absolutePath);
      const detected = await detectDefaultBranch(project.absolutePath);
      const defaultBranch = detected ?? project.defaultBranch;
      return reply.send({ branches, defaultBranch });
    },
  );

  // POST /projects
  app.post("/projects", async (req, reply) => {
    const result = CreateProjectBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Validation error", details: result.error.issues });
    }
    const { name, prefix: prefixOverride, setup } = result.data;
    // Resolve a leading `~` (the New Project dialog's "add existing directory"
    // row accepts `~/...` paths, which Node's `isAbsolute` does not).
    const dirPath = expandTilde(result.data.path);

    // Validate path is absolute
    if (!isAbsolute(dirPath)) {
      return reply.status(400).send({
        error: `Path must be absolute. Got: '${result.data.path}'`,
      });
    }

    // Validate path exists and is a directory
    try {
      const stats = await stat(dirPath);
      if (!stats.isDirectory()) {
        return reply.status(400).send({
          error: `'${dirPath}' is not a directory`,
        });
      }
    } catch (err) {
      return reply.status(400).send({
        error: `Path does not exist or is not accessible: '${dirPath}'`,
      });
    }

    // Check if already registered (by absolutePath)
    const existingByPath = getAllProjects().find((p) => p.absolutePath === dirPath);
    if (existingByPath) {
      return reply.status(409).send({
        error: `This directory is already registered as project '${existingByPath.id}'.`,
        conflictWith: existingByPath.id,
      });
    }

    // Check if this is a git repo (determines isGit flag)
    const isGit = await isGitRepo(dirPath);

    // Determine project id
    const displayName = name ?? basename(dirPath);
    const id = slugify(displayName);

    // Defense in depth: the id is used to build filesystem paths, so reject any
    // traversal token (slugify already prevents this, but a corrupt manifest or
    // future change must not be able to slip through).
    if (!isSafeProjectId(id)) {
      return reply.status(400).send({ error: `Invalid project id derived from '${displayName}'.` });
    }

    // Check uniqueness of id
    if (getProject(id)) {
      return reply.status(409).send({
        error: `Project '${id}' already exists. Use a different name.`,
        conflictWith: id,
      });
    }

    // Determine prefix. An explicit --prefix override that collides is a user
    // error (409); an auto-generated one is silently disambiguated (tes → tes2)
    // since the prefix is just an internal handle, not something to block on.
    const prefixTaken = (p: string) => getAllProjects().some((proj) => proj.prefix === p);
    let wantedPrefix: string;
    if (prefixOverride) {
      wantedPrefix = prefixOverride;
      const prefixCollision = getAllProjects().find((p) => p.prefix === wantedPrefix);
      if (prefixCollision) {
        return reply.status(409).send({
          error: `Prefix '${wantedPrefix}' already used by project '${prefixCollision.id}'. Choose a different prefix.`,
          conflictWith: prefixCollision.id,
        });
      }
    } else {
      wantedPrefix = makeUniquePrefix(generateProjectPrefix(id), prefixTaken);
    }

    // Detect default branch (only for git repos)
    let defaultBranch: string | undefined;
    if (isGit) {
      defaultBranch = await detectDefaultBranch(dirPath) ?? undefined;
      // For git repos we normally require a detectable default branch — but not
      // when `setup` is requested: an initialized-but-commitless repo has no
      // branch yet, and runProjectSetup will establish `main` below (then
      // re-detect). Rejecting here would make `setup:true` unusable on such a repo.
      if (!defaultBranch && !setup) {
        return reply.status(400).send({
          error: `Could not detect default branch for '${dirPath}'. Pass --default-branch=<name>.`,
        });
      }
    }

    const record: ProjectRecord = {
      id,
      absolutePath: dirPath,
      prefix: wantedPrefix,
      isGit,
      defaultBranch,
      createdAt: new Date().toISOString(),
      directSessions: [],
      worktrees: [],
    };

    try {
      await addProject(record);
    } catch (err) {
      // Race condition — another request added it between our check and add
      return reply.status(409).send({
        error: `Project '${id}' already exists.`,
        conflictWith: id,
      });
    }

    // Optionally run the git-ready setup script (init + .gitignore + initial
    // `main` commit) against the directory, then re-detect the default branch
    // and update the record so the client gets the real base. On failure, the
    // project stays registered — never delete the user's directory — and the
    // response carries a `warning` instead of an error.
    let finalRecord = record;
    let warning: string | undefined;
    if (setup) {
      try {
        await runProjectSetup(dirPath);
        const redetected = await detectDefaultBranch(dirPath);
        finalRecord = await mutateProject(id, (p) => ({
          ...p,
          isGit: true,
          defaultBranch: redetected ?? p.defaultBranch ?? "main",
        }));
      } catch (err) {
        warning = `Project setup failed: ${String(err)}`;
      }
    }

    const apiProject = serializeProject(finalRecord);
    broadcastAll({
      type: "project:created",
      project: apiProject as unknown as Record<string, unknown>,
    });
    return reply.status(201).send(warning ? { ...apiProject, warning } : apiProject);
  });

  // POST /projects/create — create a brand new project directory with git init
  app.post("/projects/create", async (req, reply) => {
    const result = CreateNewProjectBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({
        error: "Validation error",
        details: result.error.issues,
      });
    }

    const { name, dir: dirOverride, startAgent } = result.data;

    // Validate project name
    if (!name.trim()) {
      return reply.status(400).send({ error: "Project name cannot be empty." });
    }
    if (name.includes("/") || name.includes("\\")) {
      return reply.status(400).send({
        error: "Project name cannot contain path separators (/ or \\).",
      });
    }
    if (name.includes("..")) {
      return reply.status(400).send({
        error: "Project name cannot contain '..' (path traversal).",
      });
    }
    if (name.startsWith(".")) {
      return reply.status(400).send({
        error: "Project name cannot start with a dot.",
      });
    }

    // Resolve + validate the worktree branch upfront (before touching disk).
    // Base is always `main` here — the setup script guarantees it — so a
    // `branch` of "main" would collide with the checked-out base.
    let branch = "feature";
    if (startAgent?.useWorktree) {
      branch = startAgent.branch?.trim() || "feature";
      const branchValid = validateBranch(branch);
      if (!branchValid.ok) {
        return reply.status(400).send({ error: branchValid.reason });
      }
      if (branch === "main") {
        return reply.status(400).send({
          error: "Branch cannot be 'main' — it collides with the base branch.",
        });
      }
    }

    // Check git availability
    if (!(await isGitAvailable())) {
      return reply.status(400).send({
        error: "git not found in PATH. Install git to create new projects.",
      });
    }

    // Resolve parent directory. Tilde-expand for parity with POST /projects
    // (the client only expands `~` when homeDir loaded; CLI/API callers may not).
    const settings = await readSettings();
    const rawParent = dirOverride ?? settings.defaultProjectsDir;
    const parentDir = rawParent ? expandTilde(rawParent) : rawParent;
    if (!parentDir || !isAbsolute(parentDir)) {
      return reply.status(400).send({
        error: "Parent directory must be an absolute path.",
      });
    }

    // Full project path
    const projectPath = join(parentDir, name);

    // Check if directory already exists
    try {
      await stat(projectPath);
      // If stat succeeds, directory exists
      return reply.status(409).send({
        error: `Directory already exists at '${projectPath}'.`,
        conflictWith: projectPath,
      });
    } catch (err) {
      // ENOENT is expected — directory doesn't exist
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return reply.status(400).send({
          error: `Cannot access path '${projectPath}': ${String(err)}`,
        });
      }
    }

    // Generate project id
    const id = slugify(name);

    // Defense in depth: never allow a traversal token as an id (it builds paths).
    if (!isSafeProjectId(id)) {
      return reply.status(400).send({ error: `Invalid project id derived from '${name}'.` });
    }

    // Check if project id already registered
    if (getProject(id)) {
      return reply.status(409).send({
        error: `Project '${id}' already exists. Choose a different name.`,
        conflictWith: id,
      });
    }

    // Generate a unique prefix — auto-disambiguate on collision (tes → tes2)
    // rather than failing, since the prefix is an internal handle.
    const prefix = makeUniquePrefix(
      generateProjectPrefix(id),
      (p) => getAllProjects().some((proj) => proj.prefix === p),
    );

    // Create directory, then make it git-ready (init + .gitignore + initial
    // `main` commit) via the bundled setup script.
    try {
      await mkdir(projectPath, { recursive: true });
      await runProjectSetup(projectPath);
    } catch (err) {
      // Best-effort cleanup
      try {
        await rm(projectPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
      return reply.status(400).send({
        error: `Failed to create project: ${String(err)}`,
      });
    }

    // Detect default branch (will be "main" or "master" depending on git config)
    const defaultBranch = (await detectDefaultBranch(projectPath)) ?? "main";

    // Register project
    const record: ProjectRecord = {
      id,
      absolutePath: projectPath,
      prefix,
      isGit: true,
      defaultBranch,
      createdAt: new Date().toISOString(),
      directSessions: [],
      worktrees: [],
    };

    try {
      await addProject(record);
    } catch (err) {
      // Best-effort cleanup
      try {
        await rm(projectPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
      return reply.status(409).send({
        error: `Project '${id}' already exists.`,
        conflictWith: id,
      });
    }

    const apiProject = serializeProject(record);
    broadcastAll({
      type: "project:created",
      project: apiProject as unknown as Record<string, unknown>,
    });

    // Prepare response
    const response: {
      project: typeof apiProject;
      worktree?: Record<string, unknown>;
      session?: Record<string, unknown>;
    } = { project: apiProject };

    // Optionally start agent
    if (startAgent) {
      const { modeId, prompt, useWorktree } = startAgent;

      // Resolve modeId
      let resolvedModeId: string;
      try {
        const { resolveModeId } = await import("../routes/modes.js");
        resolvedModeId = await resolveModeId(modeId);
      } catch {
        // Project created, but mode not found — still return success but skip agent
        return reply.status(201).send({
          ...response,
          warning: `Mode '${modeId}' not found. Project created but agent not started.`,
        });
      }

      const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;

      if (useWorktree) {
        // Create worktree + session. `branch` was resolved and validated
        // upfront (defaults to "feature"; rejected if "main").
        const { worktreeAdd } = await import("../services/git.js");
        const { reserveNextWorktreeNum, generateSessionId, tmuxNameForSession } = await import("../services/sessionId.js");
        const { slugifyPrompt } = await import("../services/naming.js");
        const { worktreePath: getWorktreePath } = await import("../services/paths.js");
        const { resolveUseTmux } = await import("../services/resolveUseTmux.js");
        const { spawnSession } = await import("../services/spawn.js");
        const { serializeSession } = await import("./sessions.js");
        const { resolvePlugin } = await import("../agent-plugins/registry.js");
        const { buildPrompt } = await import("../services/promptBuilder.js");
        const { loadModes } = await import("../routes/modes.js");
        const { revParse } = await import("../services/git.js");
        const { mutateProject: mutateProj } = await import("../state/project-store.js");

        const freshProject = getProject(id)!;
        const wtNum = reserveNextWorktreeNum(freshProject);
        const wtId = `${freshProject.prefix}-${wtNum}`;
        const wtPath = getWorktreePath(id, wtId);
        const useTmux = resolveUseTmux(undefined);

        // Get baseSha
        const baseSha = await revParse(projectPath, defaultBranch);

        // Create worktree
        await worktreeAdd(projectPath, wtPath, branch, defaultBranch);

        const mainSessionId = generateSessionId(wtId, "agent");
        const mainTmuxName = useTmux ? tmuxNameForSession(mainSessionId) : `__direct__-${mainSessionId}`;
        const wtName = prompt ? slugifyPrompt(prompt) || undefined : undefined;
        const mainSession: SessionRecord = {
          id: mainSessionId,
          worktreeId: wtId,
          projectId: id,
          isMain: true,
          sortOrder: 0,
          type: "agent",
          modeId: resolvedModeId,
          ...(wtName ? { name: wtName, nameSource: "auto" as const } : {}),
          tmuxName: mainTmuxName,
          useTmux,
          lifecycle: {
            state: "not_started",
            lastTransitionAt: new Date().toISOString(),
          },
          ...(prompt ? { initialPrompt: prompt } : {}),
        };

        const worktreeRecord = {
          id: wtId,
          ...(wtName ? { name: wtName } : {}),
          sortOrder: Date.now(),
          branch,
          baseBranch: defaultBranch,
          baseSha,
          createdAt: new Date().toISOString(),
          sessions: [mainSession],
        };

        // Persist worktree
        await mutateProj(id, (p) => ({
          ...p,
          worktrees: [...p.worktrees, worktreeRecord],
        }));

        // Broadcast events
        broadcastAll({
          type: "worktree:created",
          worktree: {
            id: wtId,
            projectId: id,
            branch,
            baseBranch: defaultBranch,
            baseSha,
            createdAt: worktreeRecord.createdAt,
            pinnedAt: null,
          },
        });
        broadcastAll({
          type: "session:created",
          sessionId: mainSession.id,
          worktreeId: wtId,
          projectId: id,
          sessionType: "agent",
          mode: resolvedModeId,
          snapshot: serializeSession(wtId, id, mainSession),
        });

        // Spawn agent in background
        const modes = await loadModes();
        const mode = modes.find((m) => m.id === resolvedModeId);
        if (mode) {
          const plugin = resolvePlugin(mode.cli);
          const builtPrompt = await buildPrompt({
            project: freshProject,
            worktree: worktreeRecord,
            modeContext: mode.context,
            userPrompt: prompt,
          });

          void (async () => {
            try {
              await spawnSession({
                project: freshProject,
                worktree: worktreeRecord,
                session: mainSession,
                plugin,
                daemonPort,
                systemPrompt: builtPrompt.systemPrompt,
                taskPrompt: builtPrompt.taskPrompt,
                model: mode.model,
              });
              mainSession.lifecycle = { state: "working", lastTransitionAt: new Date().toISOString() };
              await mutateProj(id, (p) => ({
                ...p,
                worktrees: p.worktrees.map((w) =>
                  w.id === wtId
                    ? { ...w, sessions: w.sessions.map((s) => (s.id === mainSession.id ? mainSession : s)) }
                    : w,
                ),
              }));
              broadcastAll({ type: "session:state", sessionId: mainSession.id, state: "working" });
            } catch (err) {
              mainSession.lifecycle = { state: "exited", lastTransitionAt: new Date().toISOString() };
              await mutateProj(id, (p) => ({
                ...p,
                worktrees: p.worktrees.map((w) =>
                  w.id === wtId
                    ? { ...w, sessions: w.sessions.map((s) => (s.id === mainSession.id ? mainSession : s)) }
                    : w,
                ),
              }));
              broadcastAll({ type: "session:state", sessionId: mainSession.id, state: "exited", reason: String(err) });
            }
          })();
        }

        response.worktree = {
          id: wtId,
          projectId: id,
          branch,
          baseBranch: defaultBranch,
          baseSha,
          createdAt: worktreeRecord.createdAt,
          pinnedAt: null,
        };
        response.session = serializeSession(wtId, id, mainSession);
      } else {
        // Create direct session
        const { generateSessionId, tmuxNameForSession } = await import("../services/sessionId.js");
        const { slugifyPrompt } = await import("../services/naming.js");
        const { resolveUseTmux } = await import("../services/resolveUseTmux.js");
        const { spawnDirectSession } = await import("../services/spawn.js");
        const { serializeSession } = await import("./sessions.js");
        const { resolvePlugin } = await import("../agent-plugins/registry.js");
        const { buildDirectPrompt } = await import("../services/promptBuilder.js");
        const { loadModes } = await import("../routes/modes.js");
        const { mutateProject: mutateProj } = await import("../state/project-store.js");

        const freshProject = getProject(id)!;
        const useTmux = resolveUseTmux(undefined);
        const sessionId = generateSessionId(id, "agent");
        const tmuxName = useTmux ? tmuxNameForSession(sessionId) : `__direct__-${sessionId}`;
        const nextDirectSeq = (freshProject.directSessionSeq ?? 0) + 1;
        const heuristicName = prompt ? slugifyPrompt(prompt) : "";
        const sessionName = heuristicName || `Direct ${nextDirectSeq}`;

        const sessionRecord: SessionRecord = {
          id: sessionId,
          projectId: id,
          isMain: false,
          sortOrder: Date.now(),
          type: "agent",
          modeId: resolvedModeId,
          name: sessionName,
          nameSource: heuristicName ? "auto" : undefined,
          tmuxName,
          useTmux,
          lifecycle: {
            state: "not_started",
            lastTransitionAt: new Date().toISOString(),
          },
          ...(prompt ? { initialPrompt: prompt } : {}),
        };

        // Persist session
        await mutateProj(id, (p) => ({
          ...p,
          directSessionSeq: nextDirectSeq,
          directSessions: [...p.directSessions, sessionRecord],
        }));

        // Broadcast
        broadcastAll({
          type: "session:created",
          sessionId,
          projectId: id,
          worktreeId: null,
          sessionType: "agent",
          mode: resolvedModeId,
          snapshot: serializeSession(null, id, sessionRecord),
        });

        // Spawn agent in background
        const modes = await loadModes();
        const mode = modes.find((m) => m.id === resolvedModeId);
        if (mode) {
          const plugin = resolvePlugin(mode.cli);
          const builtPrompt = await buildDirectPrompt({
            project: freshProject,
            modeContext: mode.context,
            userPrompt: prompt,
          });

          void (async () => {
            try {
              await spawnDirectSession({
                project: freshProject,
                session: sessionRecord,
                plugin,
                daemonPort,
                systemPrompt: builtPrompt.systemPrompt,
                taskPrompt: builtPrompt.taskPrompt,
                model: mode.model,
              });
              sessionRecord.lifecycle = { state: "working", lastTransitionAt: new Date().toISOString() };
              await mutateProj(id, (p) => ({
                ...p,
                directSessions: p.directSessions.map((s) => (s.id === sessionId ? sessionRecord : s)),
              }));
              broadcastAll({ type: "session:state", sessionId, state: "working" });
            } catch (err) {
              sessionRecord.lifecycle = { state: "exited", lastTransitionAt: new Date().toISOString() };
              await mutateProj(id, (p) => ({
                ...p,
                directSessions: p.directSessions.map((s) => (s.id === sessionId ? sessionRecord : s)),
              }));
              broadcastAll({ type: "session:state", sessionId, state: "exited", reason: String(err) });
            }
          })();
        }

        response.session = serializeSession(null, id, sessionRecord);
      }
    }

    return reply.status(201).send(response);
  });

  // PATCH /projects/:id   { hidden: boolean }
  // Toggles ProjectRecord.hidden — a visibility-only flag (sidebar + dashboard).
  // Idempotent: no-op + no broadcast when already in the requested state, so
  // cross-tab toggles don't churn the manifest. Drops the field when false to
  // keep the manifest clean (mirrors worktree pinnedAt at worktrees.ts).
  app.patch("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const bodySchema = z.object({ hidden: z.boolean() });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    }
    const { hidden } = parsed.data;

    const current = getProject(id);
    if (!current) {
      return reply.status(404).send({ error: `Project '${id}' not found` });
    }

    // Idempotent fast-path: already in the requested state — return without
    // touching disk (mutateProject always rewrites the manifest, even on a
    // no-op fn) and without broadcasting. Avoids needless fsync churn from
    // cross-tab toggles.
    if (!!current.hidden === hidden) {
      return reply.send({ ok: true, project: serializeProject(current) });
    }

    let changed = false;
    let updated: ProjectRecord;
    try {
      updated = await mutateProject(id, (p) => {
        const isHidden = !!p.hidden;
        if (isHidden === hidden) {
          // No state change — return unchanged (cheap idempotent rewrite).
          return p;
        }
        changed = true;
        if (hidden) {
          return { ...p, hidden: true };
        }
        // Drop the field rather than setting false so the JSON stays clean.
        const { hidden: _drop, ...rest } = p;
        void _drop;
        return rest as ProjectRecord;
      });
    } catch (err) {
      // Project deleted between the check and the lock.
      if (err instanceof Error && /not found/i.test(err.message)) {
        return reply.status(404).send({ error: `Project '${id}' not found` });
      }
      throw err;
    }

    const apiProject = serializeProject(updated);
    if (changed) {
      broadcastAll({
        type: "project:updated",
        project: apiProject as unknown as Record<string, unknown>,
      });
    }
    return reply.send({ ok: true, project: apiProject });
  });

  // DELETE /projects/:id
  app.delete("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) {
      return reply.status(404).send({ error: `Project '${id}' not found` });
    }

    // Cascade: release every session's runtime, then remove the worktree dirs.
    // This MUST go through releaseSessionRuntime, not a bare `killSession`: a
    // `useTmux: false` session (direct-pty, and every json session) has no pane
    // to kill, so tmux-only teardown left its pty child and its JsonAgentSession
    // — turn process group and open SQLite handles — running while the code
    // below rm -rf's the very data dir those handles point at.
    for (const session of project.directSessions) {
      await releaseSessionRuntime(session, { clearAttachments: true });
    }

    for (const wt of project.worktrees) {
      for (const session of wt.sessions) {
        await releaseSessionRuntime(session, { clearAttachments: true });
      }
      try {
        const { worktreeRemove } = await import("../services/git.js");
        const { worktreePath } = await import("../services/paths.js");
        await worktreeRemove(project.absolutePath, worktreePath(id, wt.id));
      } catch {
        // best-effort
      }
    }

    try {
      await deleteProject(id);
      // Remove the project's DATA dir (never the user's checkout). Guard the
      // path so a malformed id (".", "..", a stale manifest) can never escape
      // ~/.vibe-station/projects/<id> and rm a parent like the data root.
      const dataDir = projectDir(id);
      if (!isSafeProjectId(id)) {
        throw new Error(`Refusing to delete data dir for unsafe project id '${id}'`);
      }
      assertSafeToDelete(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    } catch (err) {
      return reply.status(500).send({ error: `Failed to delete project: ${String(err)}` });
    }

    broadcastAll({ type: "project:deleted", projectId: id });
    return reply.send({ ok: true });
  });

  // ── Project-scoped file browsing (for direct sessions) ─────────────────────
  // A direct session runs in the project's base directory (no worktree). These
  // mirror the worktree /tree, /file-list, and /files/* endpoints but resolve
  // against `project.absolutePath`. No git/diff endpoints — a project's base
  // dir is browsed as plain files.

  // GET /projects/:projectId/tree?path=&showHidden=
  app.get("/projects/:projectId/tree", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { path: subPath = "", showHidden } = req.query as {
      path?: string;
      showHidden?: string;
    };

    const project = getProject(projectId);
    if (!project) return reply.status(404).send({ error: `Project '${projectId}' not found` });

    const root = project.absolutePath;
    let targetPath: string;
    try {
      targetPath = resolveInsideDir(root, subPath);
    } catch {
      return reply.status(403).send({ error: "Access denied." });
    }

    const ignoreMatcher = buildIgnoreMatcher(root);
    const hideDotfiles = showHidden === "false";

    try {
      let resolvedTarget = targetPath;
      try { resolvedTarget = await realpath(targetPath); } catch { /* broken symlink — readdir will 404 */ }

      const entries = await readdir(targetPath, { withFileTypes: true });
      const mapped = entries
        .filter((e) => {
          if (hideDotfiles && e.name.startsWith(".")) return false;
          return !ignoreMatcher.ignores(join(resolvedTarget, e.name), e.isDirectory());
        })
        .map(async (e) => {
          let type: "dir" | "file" = e.isDirectory() ? "dir" : "file";
          if (e.isSymbolicLink()) {
            try {
              const s = await stat(join(targetPath, e.name));
              type = s.isDirectory() ? "dir" : "file";
            } catch {
              // Broken symlink — treat as file
            }
          }
          return { name: e.name, type, path: join(subPath, e.name) };
        });
      const result = await Promise.all(mapped);
      return reply.send(result);
    } catch {
      return reply.status(404).send({ error: `Path not found: ${subPath}` });
    }
  });

  // GET /projects/:projectId/file-list
  app.get("/projects/:projectId/file-list", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = getProject(projectId);
    if (!project) return reply.status(404).send({ error: `Project '${projectId}' not found` });
    try {
      const result = await listFiles(project.absolutePath);
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: `Failed to list files: ${msg}` });
    }
  });

  // GET /projects/:projectId/files/*path
  app.get("/projects/:projectId/files/*", async (req, reply) => {
    const { projectId } = req.params as { projectId: string; "*": string };
    const filePath = (req.params as { "*": string })["*"];

    const project = getProject(projectId);
    if (!project) return reply.status(404).send({ error: `Project '${projectId}' not found` });

    let absPath: string;
    try {
      absPath = resolveInsideDir(project.absolutePath, filePath);
    } catch {
      return reply.status(403).send({ error: "Access denied." });
    }

    try {
      const stats = await stat(absPath);

      const HARD_LIMIT = 50 * 1024 * 1024; // 50 MB
      const BINARY_LIMIT = 1 * 1024 * 1024; // 1 MB

      if (stats.size > HARD_LIMIT) {
        return reply.status(422).send({ error: "File too large (>50MB)", reason: "size_limit" });
      }

      const buf = await readFile(absPath);

      const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
      const imageMime = IMAGE_MIME[ext];
      if (imageMime) {
        return reply
          .header("Cache-Control", "private, max-age=60")
          .header("Content-Type", imageMime)
          .send(buf);
      }

      const sampleSize = Math.min(buf.length, 8192);
      const isBinary = buf.slice(0, sampleSize).includes(0);
      if (isBinary && stats.size > BINARY_LIMIT) {
        return reply
          .status(422)
          .send({ error: "Binary file (>1MB) — preview unavailable", reason: "binary" });
      }

      const content = buf.toString("utf8");
      const etag = `"${createHash("md5").update(content).digest("hex")}"`;

      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === etag) {
        return reply.status(304).send();
      }

      return reply.header("ETag", etag).type("text/plain").send(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.status(404).send({ error: `File not found: ${filePath}` });
      }
      return reply.status(422).send({ error: "Cannot read file", reason: String(err) });
    }
  });
}
