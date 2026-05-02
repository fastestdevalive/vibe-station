import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import {
  getAllProjects,
  getProject,
  addProject,
  deleteProject,
} from "../state/project-store.js";
import { isGitRepo, detectDefaultBranch } from "../services/git.js";
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
  };
}

const CreateProjectBody = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(64).optional(),
  prefix: z.string().min(1).max(6).optional(),
});

export function registerProjectRoutes(app: FastifyInstance): void {
  // GET /projects
  app.get("/projects", async (_req, reply) => {
    return reply.send(getAllProjects().map(serializeProject));
  });

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
