/**
 * Settings routes — GET/PATCH /settings
 * Manages user-configurable settings stored in ~/.vibe-station/config.json
 */
import type { FastifyInstance } from "fastify";
import { homedir } from "node:os";
import { z } from "zod";
import { readSettings, writeSettings } from "../services/config.js";

const PatchSettingsBody = z.object({
  defaultProjectsDir: z.string().min(1).optional(),
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

    const { defaultProjectsDir } = result.data;

    // Validate path is absolute if provided
    if (defaultProjectsDir && !defaultProjectsDir.startsWith("/")) {
      return reply.status(400).send({
        error: "defaultProjectsDir must be an absolute path",
      });
    }

    await writeSettings({ defaultProjectsDir });
    return reply.send({ ok: true });
  });
}
