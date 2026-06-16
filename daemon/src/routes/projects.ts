import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import {
  getAllProjects,
  getProject,
  addProject,
  deleteProject,
  mutateProject,
} from "../state/project-store.js";
import { isGitRepo, detectDefaultBranch, listBranches } from "../services/git.js";
import { generateProjectPrefix } from "../services/prefix.js";
import { slugify } from "../services/slugify.js";
import { projectDir } from "../services/paths.js";
import { broadcastAll } from "../broadcaster.js";
import type { ProjectRecord } from "../types.js";

/** Map internal ProjectRecord to API shape consumed by the web UI. */
function serializeProject(p: ProjectRecord) {
  return {
    id: p.id,
    name: p.id,
    path: p.absolutePath,
    prefix: p.prefix,
    defaultBranch: p.defaultBranch,
    createdAt: p.createdAt,
    // Always emit so the client never has to special-case undefined.
    hidden: !!p.hidden,
  };
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
      if (!(await isGitRepo(project.absolutePath))) {
        return reply
          .status(400)
          .send({ error: `'${project.absolutePath}' is not a git repository` });
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
    const { path: repoPath, name, prefix: prefixOverride } = result.data;

    // Validate git repo
    if (!(await isGitRepo(repoPath))) {
      return reply
        .status(400)
        .send({ error: `'${repoPath}' is not a git repository` });
    }

    // Determine project id
    const displayName = name ?? basename(repoPath);
    const id = slugify(displayName);

    // Check uniqueness of id
    if (getProject(id)) {
      return reply.status(409).send({
        error: `Project '${id}' already exists. Pass --name=<override> to use a different id.`,
        conflictWith: id,
      });
    }

    // Determine prefix
    const wantedPrefix = prefixOverride ?? generateProjectPrefix(id);
    // Check prefix uniqueness
    const prefixCollision = getAllProjects().find((p) => p.prefix === wantedPrefix);
    if (prefixCollision) {
      return reply.status(409).send({
        error: `Prefix '${wantedPrefix}' already used by project '${prefixCollision.id}'. Pass --prefix=<override>.`,
        conflictWith: prefixCollision.id,
      });
    }

    // Detect default branch
    const defaultBranch = await detectDefaultBranch(repoPath);
    if (!defaultBranch) {
      return reply.status(400).send({
        error: `Could not detect default branch for '${repoPath}'. Pass --default-branch=<name>.`,
      });
    }

    const record: ProjectRecord = {
      id,
      absolutePath: repoPath,
      prefix: wantedPrefix,
      defaultBranch,
      createdAt: new Date().toISOString(),
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

    const apiProject = serializeProject(record);
    broadcastAll({
      type: "project:created",
      project: apiProject as unknown as Record<string, unknown>,
    });
    return reply.status(201).send(apiProject);
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

    // Cascade: kill all tmux sessions and remove worktree dirs
    // (tmux kills and git worktree removes happen here; import lazily to avoid
    //  circular deps — these services may not be available in Phase 3 yet)
    for (const wt of project.worktrees) {
      for (const session of wt.sessions) {
        try {
          const { killSession } = await import("../services/tmux.js");
          await killSession(session.tmuxName);
        } catch {
          // best-effort
        }
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
      // Remove the project directory from disk
      await rm(projectDir(id), { recursive: true, force: true });
    } catch (err) {
      return reply.status(500).send({ error: `Failed to delete project: ${String(err)}` });
    }

    broadcastAll({ type: "project:deleted", projectId: id });
    return reply.send({ ok: true });
  });
}
