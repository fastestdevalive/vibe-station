/**
 * Mode routes — CRUD for agent modes.
 * Stored in ~/.viberun/modes.json (max 10 modes).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { modesPath, vrunHome } from "../services/paths.js";
import { broadcastAll } from "../broadcaster.js";
import { getAllProjects } from "../state/project-store.js";
import type { CliId } from "../types.js";

const MAX_MODES = 10;
const MAX_CONTEXT_LEN = 10_000;

interface Mode {
  id: string;
  name: string;
  cli: CliId;
  context: string;
  createdAt: string;
}

// In-memory cache for modes
let modesCache: Mode[] | null = null;

export async function loadModes(): Promise<Mode[]> {
  if (modesCache !== null) return modesCache;
  try {
    const content = await readFile(modesPath(), "utf8");
    modesCache = JSON.parse(content) as Mode[];
  } catch {
    modesCache = [];
  }
  return modesCache;
}

async function saveModes(modes: Mode[]): Promise<void> {
  await mkdir(vrunHome(), { recursive: true });
  await writeFile(modesPath(), JSON.stringify(modes, null, 2), "utf8");
  modesCache = modes;
}

export function _resetModesCacheForTest(): void {
  modesCache = null;
}

const CreateModeBody = z.object({
  name: z.string().min(1).max(64),
  cli: z.enum(["claude", "cursor", "opencode"]),
  context: z.string().min(1).max(MAX_CONTEXT_LEN),
  presetId: z.string().optional(),
});

const UpdateModeBody = z.object({
  name: z.string().min(1).max(64).optional(),
  context: z.string().min(1).max(MAX_CONTEXT_LEN).optional(),
});

function generateId(): string {
  return `mode-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Check if any running session references this modeId. */
function isModeInUse(modeId: string): boolean {
  for (const project of getAllProjects()) {
    for (const wt of project.worktrees) {
      for (const session of wt.sessions) {
        if (session.modeId === modeId) return true;
      }
    }
  }
  return false;
}

export function registerModeRoutes(app: FastifyInstance): void {
  // GET /modes
  app.get("/modes", async (_req, reply) => {
    return reply.send(await loadModes());
  });

  // POST /modes
  app.post("/modes", async (req, reply) => {
    const result = CreateModeBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Validation error", details: result.error.issues });
    }
    const { name, cli, context, presetId } = result.data;

    const modes = await loadModes();
    if (modes.length >= MAX_MODES) {
      return reply.status(400).send({ error: `Maximum ${MAX_MODES} modes allowed` });
    }

    if (modes.some((m) => m.name === name)) {
      return reply.status(409).send({
        error: `A mode named '${name}' already exists.`,
        conflictWith: name,
      });
    }

    const mode: Mode = {
      id: generateId(),
      name,
      cli,
      context,
      createdAt: new Date().toISOString(),
    };

    await saveModes([...modes, mode]);
    broadcastAll({ type: "mode:created", mode: mode as unknown as Record<string, unknown> });
    return reply.status(201).send(mode);
  });

  // PUT /modes/:id
  app.put("/modes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = UpdateModeBody.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: "Validation error", details: result.error.issues });
    }
    const { name, context } = result.data;

    const modes = await loadModes();
    const idx = modes.findIndex((m) => m.id === id);
    if (idx === -1) return reply.status(404).send({ error: `Mode '${id}' not found` });

    if (name && modes.some((m, i) => i !== idx && m.name === name)) {
      return reply.status(409).send({ error: `A mode named '${name}' already exists.` });
    }

    const updated = {
      ...modes[idx]!,
      ...(name ? { name } : {}),
      ...(context ? { context } : {}),
    };
    modes[idx] = updated;
    await saveModes(modes);
    broadcastAll({ type: "mode:updated", mode: updated as unknown as Record<string, unknown> });
    return reply.send(updated);
  });

  // DELETE /modes/:id
  app.delete("/modes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const modes = await loadModes();
    const mode = modes.find((m) => m.id === id);
    if (!mode) return reply.status(404).send({ error: `Mode '${id}' not found` });

    if (isModeInUse(id)) {
      return reply.status(409).send({
        error: `Mode '${id}' is in use by active sessions. Kill those sessions first.`,
        conflictWith: id,
      });
    }

    await saveModes(modes.filter((m) => m.id !== id));
    broadcastAll({ type: "mode:deleted", modeId: id });
    return reply.send({ ok: true });
  });
}
