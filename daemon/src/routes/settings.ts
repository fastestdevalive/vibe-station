/**
 * Settings routes — GET/PATCH /settings
 * Manages user-configurable settings stored in ~/.vibe-station/config.json
 */
import type { FastifyInstance } from "fastify";
import { homedir } from "node:os";
import { z } from "zod";
import { readSettings, writeSettings } from "../services/config.js";
import { setSkillPaths } from "../services/userSkillCatalog.js";

const PatchSettingsBody = z.object({
  defaultProjectsDir: z.string().min(1).optional(),
  skillPaths: z.array(z.string().min(1)).optional(),
});

export function registerSettingsRoutes(app: FastifyInstance): void {
  // GET /settings
  // `homeDir` is a runtime-computed convenience (NOT persisted) so the web UI
  // can collapse absolute paths to `~` for display and expand `~` back before
  // hitting path-based endpoints.
  app.get("/settings", async (_req, reply) => {
    const settings = await readSettings();
    return reply.send({ ...settings, homeDir: homedir() });
  });

  // PATCH /settings
  app.patch("/settings", async (req, reply) => {
    const result = PatchSettingsBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({
        error: "Validation error",
        details: result.error.issues,
      });
    }

    const { defaultProjectsDir, skillPaths } = result.data;

    // Validate path is absolute if provided
    if (defaultProjectsDir && !defaultProjectsDir.startsWith("/")) {
      return reply.status(400).send({
        error: "defaultProjectsDir must be an absolute path",
      });
    }

    // Validate skillPaths are all absolute paths (System Boundaries: 400 VALIDATION_ERROR).
    if (skillPaths && skillPaths.some((p) => !p.startsWith("/"))) {
      return reply.status(400).send({
        error: "skillPaths must all be absolute paths",
      });
    }

    await writeSettings({ defaultProjectsDir, skillPaths });
    if (skillPaths !== undefined) {
      // Re-scan + re-watch the new directory set (skill-invocation-in-chat 4.6).
      // Best-effort (m12): the settings write above already succeeded on
      // disk — a rescan/watch failure (e.g. an unreadable directory) must
      // not 500 a request that otherwise succeeded. Still awaited (not
      // fire-and-forget) so a caller reading GET /skills right after this
      // PATCH sees the fresh scan, not a stale one.
      try {
        await setSkillPaths(skillPaths);
      } catch (err) {
        req.log.warn({ err }, "setSkillPaths failed after a successful settings write");
      }
    }
    return reply.send({ ok: true });
  });
}
