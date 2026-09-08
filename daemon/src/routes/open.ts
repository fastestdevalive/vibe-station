/**
 * POST /open — upsert a project by path and navigate the Tauri window to it.
 *
 * Contract:
 *   Body: { path: string }       // absolute filesystem path
 *   200:  { projectId: string }
 *   400:  { error: "path_not_found" | "path_not_directory" | "invalid_path" }
 *   401:  UNAUTHORIZED (handled by auth middleware)
 *
 * The route also maintains a 3s replay buffer so a navigate event is delivered
 * to clients that connect shortly after the POST (e.g. Tauri window boot race).
 */
import type { FastifyInstance } from "fastify";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { getAllProjects, addProject, getProject } from "../state/project-store.js";
import { broadcastAll } from "../broadcaster.js";
import {
  isGitRepo,
  detectDefaultBranch,
} from "../services/git.js";
import { generateProjectPrefix, makeUniquePrefix } from "../services/prefix.js";
import { slugify, isSafeProjectId } from "../services/slugify.js";
import type { ProjectRecord } from "../types.js";
import type { WSConnection } from "../ws/connection.js";

const OpenBody = z.object({ path: z.string().min(1) });

interface NavigateReplay {
  projectId: string;
  expiresAt: number;
}

let lastNavigate: NavigateReplay | null = null;

/**
 * If a recent navigate event exists and hasn't expired, replay it to this
 * newly-connected WS client. Called from ws/server.ts on new connection.
 */
export function replayNavigateToConnection(conn: WSConnection): void {
  if (lastNavigate && Date.now() < lastNavigate.expiresAt) {
    conn.send({ type: "navigate", projectId: lastNavigate.projectId });
  }
}

export function registerOpenRoute(app: FastifyInstance): void {
  app.post("/open", async (req, reply) => {
    const result = OpenBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: "invalid_path" });
    }

    const rawPath = result.data.path;
    if (!isAbsolute(rawPath)) {
      return reply.status(400).send({ error: "invalid_path", detail: "Path must be absolute" });
    }

    let stats;
    try {
      stats = await stat(rawPath);
    } catch {
      return reply.status(400).send({ error: "path_not_found" });
    }

    if (!stats.isDirectory()) {
      return reply.status(400).send({ error: "path_not_directory" });
    }

    // Upsert: return existing project if already registered by absolutePath
    const existing = getAllProjects().find((p) => p.absolutePath === rawPath);
    if (existing) {
      const projectId = existing.id;
      emitNavigate(projectId);
      return reply.send({ projectId });
    }

    // Register new project
    const displayName = basename(rawPath);
    const id = slugify(displayName);
    if (!isSafeProjectId(id)) {
      return reply.status(400).send({ error: "invalid_path", detail: "Could not derive a safe project id" });
    }

    const prefixTaken = (p: string) => getAllProjects().some((proj) => proj.prefix === p);
    const prefix = makeUniquePrefix(generateProjectPrefix(id), prefixTaken);

    const isGit = await isGitRepo(rawPath);
    let defaultBranch: string | undefined;
    if (isGit) {
      defaultBranch = (await detectDefaultBranch(rawPath)) ?? undefined;
    }

    // Handle id collision: find a free one by appending a counter
    let finalId = id;
    let counter = 2;
    while (getProject(finalId)) {
      finalId = `${id}-${counter++}`;
      if (!isSafeProjectId(finalId)) {
        return reply.status(400).send({ error: "invalid_path", detail: "Could not derive a safe project id after deduplication" });
      }
    }

    const record: ProjectRecord = {
      id: finalId,
      absolutePath: rawPath,
      prefix,
      isGit,
      defaultBranch,
      createdAt: new Date().toISOString(),
      directSessions: [],
      worktrees: [],
    };

    try {
      await addProject(record);
    } catch {
      // Race: another request added same id — try to find by path again
      const raceExisting = getAllProjects().find((p) => p.absolutePath === rawPath);
      if (raceExisting) {
        emitNavigate(raceExisting.id);
        return reply.send({ projectId: raceExisting.id });
      }
      return reply.status(500).send({ error: "internal_error" });
    }

    broadcastAll({
      type: "project:created",
      project: { id: record.id, name: record.id, path: record.absolutePath, prefix: record.prefix, isGit: record.isGit, defaultBranch: record.defaultBranch, createdAt: record.createdAt, hidden: false } as unknown as Record<string, unknown>,
    });

    emitNavigate(record.id);
    return reply.send({ projectId: record.id });
  });
}

function emitNavigate(projectId: string): void {
  lastNavigate = { projectId, expiresAt: Date.now() + 3000 };
  broadcastAll({ type: "navigate", projectId });
}
