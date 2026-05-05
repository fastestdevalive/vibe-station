import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import ignore from "ignore";
import { getProject, getAllProjects, mutateProject } from "../state/project-store.js";
import { validateBranch, branchExistsInRepo } from "../services/branchValidator.js";
import { reserveNextWorktreeNum, buildTmuxName } from "../services/sessionId.js";
import { worktreeAdd, worktreeRemove, revParse, fetchOrigin, branchExists } from "../services/git.js";
import { killSession } from "../services/tmux.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { rollbackWorktreeCreate } from "../services/rollback.js";
import { spawnSession } from "../services/spawn.js";
import { worktreePath as getWorktreePath, cleanupSessionDataDir } from "../services/paths.js";
import { broadcastAll } from "../broadcaster.js";
import { serializeSession } from "./sessions.js";
import { resolvePlugin } from "../agent-plugins/registry.js";
import { resolveUseTmux } from "../services/resolveUseTmux.js";
import type { AgentPlugin } from "../services/spawn.js";
import type { WorktreeRecord, SessionRecord, ProjectRecord } from "../types.js";

const MAX_DIFF_BYTES = 512 * 1024;

/** Parse `git status -z --porcelain=v1`; handles rename/copy second path record. */
function parsePorcelainZ(stdout: string): { path: string; status: string }[] {
  const entries: { path: string; status: string }[] = [];
  const records = stdout.split("\0");
  let i = 0;
  while (i < records.length) {
    const rec = records[i] ?? "";
    if (!rec || rec.length < 3) {
      i += 1;
      continue;
    }
    const x = rec[0]!;
    const y = rec[1]!;
    const pathPart = rec.slice(3);
    if (!pathPart) {
      i += 1;
      continue;
    }
    const status = x === "?" ? "?" : x !== " " ? x : y;
    entries.push({ path: pathPart, status });
    if (x === "R" || x === "C") {
      i += 2;
    } else {
      i += 1;
    }
  }
  return entries;
}

/** Parse `git diff -z --name-status <mergeBase>` into path entries. */
function parseBranchNameStatus(stdout: string): { path: string; status: string }[] {
  const result: { path: string; status: string }[] = [];
  const tokens = stdout.split("\0").filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i] ?? "";
    const statusChar = statusToken[0];
    if (!statusChar) {
      i += 1;
      continue;
    }
    if (statusChar === "R" || statusChar === "C") {
      const newPath = tokens[i + 2];
      if (newPath) {
        result.push({ path: newPath, status: statusChar === "C" ? "M" : "R" });
      }
      i += 3;
    } else {
      const pathPart = tokens[i + 1];
      if (pathPart) {
        const mapped =
          statusChar === "T" ? "M" : statusChar === "U" ? "M" : statusChar;
        result.push({ path: pathPart, status: mapped });
      }
      i += 2;
    }
  }
  return result;
}

/** Map internal WorktreeRecord to API shape (adds projectId, drops nested sessions). */
function serializeWorktree(projectId: string, w: WorktreeRecord) {
  return {
    id: w.id,
    projectId,
    branch: w.branch,
    baseBranch: w.baseBranch,
    baseSha: w.baseSha,
    createdAt: w.createdAt,
  };
}

const CreateWorktreeBody = z.object({
  projectId: z.string().min(1),
  modeId: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  prompt: z.string().optional(),
  useTmux: z.boolean().optional(),
});

async function runMainSpawnJob(opts: {
  projectId: string;
  wtId: string;
  freshProject: ProjectRecord;
  worktreeRecord: WorktreeRecord;
  mainSession: SessionRecord;
  plugin: AgentPlugin;
  daemonPort: number;
  builtPrompt: { systemPrompt: string; taskPrompt?: string };
}): Promise<void> {
  const { projectId, wtId, freshProject, worktreeRecord, mainSession, plugin, daemonPort, builtPrompt } =
    opts;

  try {
    await spawnSession({
      project: freshProject,
      worktree: worktreeRecord,
      session: mainSession,
      plugin,
      daemonPort,
      systemPrompt: builtPrompt.systemPrompt,
      taskPrompt: builtPrompt.taskPrompt,
    });

    mainSession.lifecycle = {
      state: "working",
      lastTransitionAt: new Date().toISOString(),
    };
    worktreeRecord.sessions = [mainSession];

    await mutateProject(projectId, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === wtId
          ? { ...w, sessions: w.sessions.map((s) => (s.id === mainSession.id ? mainSession : s)) }
          : w,
      ),
    }));

    broadcastAll({
      type: "session:state",
      sessionId: mainSession.id,
      state: "working",
    });
  } catch (err) {
    const reason = String(err);
    await mutateProject(projectId, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === wtId
          ? {
              ...w,
              sessions: w.sessions.map((s) =>
                s.id === mainSession.id
                  ? {
                      ...s,
                      lifecycle: {
                        state: "exited",
                        lastTransitionAt: new Date().toISOString(),
                        reason,
                      },
                    }
                  : s,
              ),
            }
          : w,
      ),
    }));
    broadcastAll({
      type: "session:state",
      sessionId: mainSession.id,
      state: "exited",
      reason,
    });
  }
}

export function registerWorktreeRoutes(app: FastifyInstance): void {
  // GET /worktrees?project=:id
  app.get("/worktrees", async (req, reply) => {
    const { project: projectId } = req.query as { project?: string };
    if (projectId) {
      const project = getProject(projectId);
      if (!project) return reply.status(404).send({ error: `Project '${projectId}' not found` });
      return reply.send(project.worktrees.map((w) => serializeWorktree(project.id, w)));
    }
    // Return all worktrees across all projects
    const all = getAllProjects().flatMap((p) => p.worktrees.map((w) => serializeWorktree(p.id, w)));
    return reply.send(all);
  });

  // POST /worktrees
  app.post("/worktrees", async (req, reply) => {
    const result = CreateWorktreeBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Validation error", details: result.error.issues });
    }
    const { projectId, branch, baseBranch: baseBranchInput, modeId, useTmux: rawUseTmux } = result.data;
    const useTmux = resolveUseTmux(rawUseTmux);

    const project = getProject(projectId);
    if (!project) return reply.status(404).send({ error: `Project '${projectId}' not found` });

    // 1. Validate branch name
    const branchValid = validateBranch(branch);
    if (!branchValid.ok) {
      return reply.status(400).send({ error: branchValid.reason });
    }

    // Check branch doesn't already exist in the repo
    if (await branchExistsInRepo(project.absolutePath, branch)) {
      return reply.status(409).send({
        error: `Branch '${branch}' already exists. Pick a different name.`,
        conflictWith: branch,
      });
    }

    // 2. Resolve baseBranch
    const baseBranch = baseBranchInput ?? project.defaultBranch;

    // Ensure baseBranch exists locally — try fetching from origin first
    if (!(await branchExists(project.absolutePath, baseBranch))) {
      await fetchOrigin(project.absolutePath, baseBranch);
      if (!(await branchExists(project.absolutePath, baseBranch))) {
        return reply.status(400).send({
          error: `Base branch '${baseBranch}' not found locally and could not be fetched from origin.`,
        });
      }
    }

    // Perform creation under project mutex
    let createdWorktree: WorktreeRecord | undefined;
    let worktreeAdded = false;

    try {
      // 3. Reserve worktree id under mutex (read project fresh from store)
      const freshProject = getProject(projectId)!;
      const wtNum = reserveNextWorktreeNum(freshProject);
      const wtId = `${freshProject.prefix}-${wtNum}`;
      const wtPath = getWorktreePath(projectId, wtId);

      // Capture baseSha before creating worktree
      const baseSha = await revParse(project.absolutePath, baseBranch);

      // 4. git worktree add
      await worktreeAdd(project.absolutePath, wtPath, branch, baseBranch);
      worktreeAdded = true;

      // Build the main session record
      const mainTmuxName = useTmux ? buildTmuxName(freshProject.prefix, wtNum, "m") : `__direct__-${wtId}-m`;
      const mainSession: SessionRecord = {
        id: `${wtId}-m`,
        slot: "m",
        type: "agent",
        modeId,
        tmuxName: mainTmuxName,
        useTmux,
        lifecycle: {
          state: "not_started",
          lastTransitionAt: new Date().toISOString(),
        },
      };

      const worktreeRecord: WorktreeRecord = {
        id: wtId,
        branch,
        baseBranch,
        baseSha,
        createdAt: new Date().toISOString(),
        sessions: [mainSession],
      };

      // 5. Persist to manifest (structural change — immediate write)
      await mutateProject(projectId, (p) => ({
        ...p,
        worktrees: [...p.worktrees, worktreeRecord],
      }));
      createdWorktree = worktreeRecord;

      const modes = await (await import("../routes/modes.js")).loadModes();
      const mode = modes.find((m) => m.id === modeId);
      if (!mode) {
        throw new Error(`Mode '${modeId}' not found`);
      }

      const plugin = resolvePlugin(mode.cli);

      const { buildPrompt } = await import("../services/promptBuilder.js");
      const builtPrompt = await buildPrompt({
        project: freshProject,
        worktree: worktreeRecord,
        modeContext: mode.context,
        userPrompt: result.data.prompt,
      });

      const daemonPort = (app.server.address() as { port?: number })?.port ?? 7421;

      const apiWorktreeEarly = serializeWorktree(projectId, createdWorktree);
      broadcastAll({
        type: "worktree:created",
        worktree: apiWorktreeEarly as unknown as Record<string, unknown>,
      });
      broadcastAll({
        type: "session:created",
        sessionId: mainSession.id,
        worktreeId: wtId,
        sessionType: "agent",
        mode: modeId,
        snapshot: serializeSession(wtId, mainSession),
      });

      void runMainSpawnJob({
        projectId,
        wtId,
        freshProject,
        worktreeRecord,
        mainSession,
        plugin,
        daemonPort,
        builtPrompt,
      });

    } catch (err) {
      // Rollback if we got past git worktree add
      if (worktreeAdded && createdWorktree) {
        const rollbackErrors = await rollbackWorktreeCreate(project, createdWorktree);
        // Remove from manifest if it was written
        try {
          await mutateProject(projectId, (p) => ({
            ...p,
            worktrees: p.worktrees.filter((w) => w.id !== createdWorktree!.id),
          }));
        } catch {
          // best-effort
        }
        if (rollbackErrors.length > 0) {
          console.error(`[worktrees] Rollback had errors: ${rollbackErrors.join("; ")}`);
        }
      }
      return reply.status(500).send({
        error: `Failed to create worktree: ${String(err)}`,
        reason: String(err),
      });
    }

    const apiWorktree = serializeWorktree(projectId, createdWorktree!);
    return reply.status(201).send(apiWorktree);
  });

  // DELETE /worktrees/:id
  app.delete("/worktrees/:id", async (req, reply) => {
    const { id: wtId } = req.params as { id: string };
    const { purge } = req.query as { purge?: string };
    const shouldPurge = purge === "true" || purge === "1";

    // Find the project that owns this worktree
    const project = getAllProjects().find((p) => p.worktrees.some((w) => w.id === wtId));
    if (!project) return reply.status(404).send({ error: `Worktree '${wtId}' not found` });

    const worktree = project.worktrees.find((w) => w.id === wtId)!;

    // Kill all sessions (tmux or direct-pty)
    for (const session of worktree.sessions) {
      if (!session.useTmux) {
        directPtyRegistry.get(session.id)?.kill?.();
      } else {
        try {
          await killSession(session.tmuxName);
        } catch {
          // best-effort
        }
      }
      // Best-effort cleanup of per-session data dir
      cleanupSessionDataDir(project.id, wtId, session.id);
    }

    if (shouldPurge) {
      // Hard delete: remove the git worktree checkout from disk
      const wtPath = getWorktreePath(project.id, wtId);
      try {
        await worktreeRemove(project.absolutePath, wtPath);
      } catch {
        // best-effort — might already be gone
      }
    }
    // Without purge: files stay on disk, branch stays. User can recover manually.

    // Remove from manifest (always)
    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.filter((w) => w.id !== wtId),
    }));

    broadcastAll({ type: "worktree:deleted", worktreeId: wtId });
    return reply.send({ ok: true });
  });

  // GET /worktrees/:id/tree?path=&showHidden=true
  app.get("/worktrees/:id/tree", async (req, reply) => {
    const { id: wtId } = req.params as { id: string };
    const { path: subPath = "", showHidden } = req.query as {
      path?: string;
      showHidden?: string;
    };

    const project = getAllProjects().find((p) => p.worktrees.some((w) => w.id === wtId));
    if (!project) return reply.status(404).send({ error: `Worktree '${wtId}' not found` });

    const wtPath = getWorktreePath(project.id, wtId);
    const targetPath = join(wtPath, subPath);

    // Build gitignore filter
    let ig: ReturnType<typeof ignore> | null = null;
    try {
      const gitignoreContent = await readFile(join(wtPath, ".gitignore"), "utf8");
      ig = ignore().add(gitignoreContent);
    } catch {
      // No .gitignore
    }

    // Dotfiles are shown by default; pass showHidden=false to filter them out.
    const hideDotfiles = showHidden === "false";

    try {
      // Resolve symlinks so gitignore paths are computed against the real location.
      // If the real path escapes the worktree root, relative() returns a "../" path
      // and we skip the gitignore check for those entries.
      let resolvedTarget = targetPath;
      try { resolvedTarget = await realpath(targetPath); } catch { /* broken symlink — readdir will 404 */ }

      const entries = await readdir(targetPath, { withFileTypes: true });
      const mapped = entries
        .filter((e) => {
          if (hideDotfiles && e.name.startsWith(".")) return false;
          // Always hide .git directory — it's noise.
          if (e.name === ".git") return false;
          // Filter gitignored paths; skip check when the real path escapes the worktree.
          if (ig) {
            const rel = relative(wtPath, join(resolvedTarget, e.name));
            if (rel && !rel.startsWith("..") && ig.ignores(rel)) return false;
          }
          return true;
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

  // GET /worktrees/:id/files/*path
  app.get("/worktrees/:id/files/*", async (req, reply) => {
    const { id: wtId } = req.params as { id: string; "*": string };
    const filePath = (req.params as { "*": string })["*"];

    const project = getAllProjects().find((p) => p.worktrees.some((w) => w.id === wtId));
    if (!project) return reply.status(404).send({ error: `Worktree '${wtId}' not found` });

    const wtPath = getWorktreePath(project.id, wtId);
    const absPath = join(wtPath, filePath);

    try {
      const stats = await stat(absPath);

      // Size limits
      const HARD_LIMIT = 50 * 1024 * 1024; // 50 MB
      const BINARY_LIMIT = 1 * 1024 * 1024; // 1 MB

      if (stats.size > HARD_LIMIT) {
        return reply.status(422).send({ error: "File too large (>50MB)", reason: "size_limit" });
      }

      // Read as buffer to detect binary
      const buf = await readFile(absPath);

      // Binary detection: look for null bytes in first 8KB
      const sampleSize = Math.min(buf.length, 8192);
      const isBinary = buf.slice(0, sampleSize).includes(0);
      if (isBinary && stats.size > BINARY_LIMIT) {
        return reply
          .status(422)
          .send({ error: "Binary file (>1MB) — preview unavailable", reason: "binary" });
      }

      const content = buf.toString("utf8");
      const etag = `"${createHash("md5").update(content).digest("hex")}"`;

      // ETag support
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

  // GET /worktrees/:id/diff/*path?scope=local|branch
  app.get("/worktrees/:id/diff/*", async (req, reply) => {
    const { id: wtId } = req.params as { id: string; "*": string };
    const filePath = (req.params as { "*": string })["*"];
    const { scope = "local" } = req.query as { scope?: string };

    const project = getAllProjects().find((p) => p.worktrees.some((w) => w.id === wtId));
    if (!project) return reply.status(404).send({ error: `Worktree '${wtId}' not found` });

    const worktree = project.worktrees.find((w) => w.id === wtId)!;
    const wtPath = getWorktreePath(project.id, wtId);

    const gitArgs =
      scope === "branch"
        ? ([
            "-c",
            "color.diff=false",
            "-c",
            "core.quotepath=false",
            "diff",
            worktree.baseSha,
            "--",
            filePath,
          ] as const)
        : ([
            "-c",
            "color.diff=false",
            "-c",
            "core.quotepath=false",
            "diff",
            "HEAD",
            "--",
            filePath,
          ] as const);

    const diffResult = spawnSync("git", [...gitArgs], {
      cwd: wtPath,
      encoding: "utf-8",
      maxBuffer: 600 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    if (diffResult.error) {
      const msg = diffResult.error.message ?? "";
      if (msg.includes("maxBuffer") || msg.includes("ENOBUFS")) {
        return reply.status(422).send({
          error: "diff_too_large",
          message: "Diff too large to display",
          path: filePath,
        });
      }
      return reply.status(500).send({
        error: `git diff failed: ${diffResult.error.message}`,
      });
    }

    if (diffResult.status !== 0 && diffResult.status !== 1) {
      const stderr = (diffResult.stderr ?? "").trim();
      return reply.status(500).send({
        error: stderr || `git diff exited with status ${diffResult.status}`,
      });
    }

    const stdout = diffResult.stdout ?? "";
    if (stdout.includes("Binary files ") && stdout.includes(" differ")) {
      return reply.status(422).send({
        error: "binary",
        message: "Binary file diff is not supported",
        path: filePath,
      });
    }
    if (stdout.length > MAX_DIFF_BYTES) {
      return reply.status(422).send({
        error: "diff_too_large",
        message: "Diff too large to display",
        path: filePath,
      });
    }

    const etag = `"${createHash("md5").update(stdout).digest("hex")}"`;
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch === etag) {
      return reply.status(304).send();
    }

    return reply.header("ETag", etag).type("text/plain").send(stdout);
  });

  // GET /worktrees/:id/changed-paths?scope=local|branch
  app.get("/worktrees/:id/changed-paths", async (req, reply) => {
    const { id: wtId } = req.params as { id: string };
    const { scope = "local" } = req.query as { scope?: string };

    const project = getAllProjects().find((p) => p.worktrees.some((w) => w.id === wtId));
    if (!project) return reply.status(404).send({ error: `Worktree '${wtId}' not found` });

    const worktree = project.worktrees.find((w) => w.id === wtId)!;
    const wtPath = getWorktreePath(project.id, wtId);

    try {
      if (scope === "branch") {
        const ns = spawnSync(
          "git",
          ["-c", "core.quotepath=false", "diff", "-z", "--name-status", worktree.baseSha],
          {
            cwd: wtPath,
            encoding: "utf-8",
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );
        if (ns.error) {
          return reply.status(500).send({ error: `git diff --name-status failed: ${ns.error.message}` });
        }
        if (ns.status !== 0 && ns.status !== 1) {
          return reply.status(500).send({
            error: (ns.stderr ?? "").trim() || "git diff --name-status failed",
          });
        }
        return reply.send(parseBranchNameStatus(ns.stdout ?? ""));
      }

      const st = spawnSync(
        "git",
        ["status", "--porcelain=v1", "-z", "-uall"],
        {
          cwd: wtPath,
          encoding: "utf-8",
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      if (st.error) {
        return reply.status(500).send({ error: `git status failed: ${st.error.message}` });
      }
      if (st.status !== 0) {
        return reply.status(500).send({
          error: (st.stderr ?? "").trim() || "git status failed",
        });
      }
      return reply.send(parsePorcelainZ(st.stdout ?? ""));
    } catch (err) {
      return reply.status(500).send({ error: `changed-paths failed: ${String(err)}` });
    }
  });
}
