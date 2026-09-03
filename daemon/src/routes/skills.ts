/**
 * Skills routes — GET /skills
 * Settings-panel-only view of the directory-scanned user skill catalog
 * (skill-invocation-in-chat Decision 3/§2). The composer popover reads
 * `session:meta.commands` instead — see `services/userSkillCatalog.ts`.
 */
import type { FastifyInstance } from "fastify";
import { getSkillDirectories, getSkillEntries } from "../services/userSkillCatalog.js";

export function registerSkillsRoutes(app: FastifyInstance): void {
  // GET /skills
  // No error status — a per-directory scan failure surfaces in
  // `directories[].error`, never a 4xx/5xx (System Boundaries).
  app.get("/skills", async (_req, reply) => {
    const skills = getSkillEntries().map((entry) => ({
      name: entry.name,
      description: entry.description ?? "",
      ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
      path: entry.path,
    }));
    return reply.send({ skills, directories: getSkillDirectories() });
  });
}
