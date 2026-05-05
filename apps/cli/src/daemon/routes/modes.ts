/**
 * Mode routes — CRUD for agent modes.
 * Stored in ~/.vibe-station/modes.json (max 10 modes).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { modesPath, vstHome } from "../services/paths.js";
import { broadcastAll } from "../broadcaster.js";
import { getAllProjects } from "../state/project-store.js";
import { resolvePlugin } from "../agent-plugins/registry.js";
import type { CliId } from "../types.js";

const MAX_MODES = 10;
const MAX_CONTEXT_LEN = 10_000;
const MAX_MODEL_LEN = 100;
const CLI_MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

const cliModelCache = new Map<CliId, { models: string[]; fetchedAt: number }>();
/** In-flight deduplication: concurrent requests share the same fetch promise. */
const cliModelInflight = new Map<CliId, Promise<{ models: string[]; error?: string }>>();

interface Mode {
  id: string;
  name: string;
  cli: CliId;
  context: string;
  createdAt: string;
  model?: string;
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
  await mkdir(vstHome(), { recursive: true });
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
  model: z.string().max(MAX_MODEL_LEN).optional(),
});

const UpdateModeBody = z.object({
  name: z.string().min(1).max(64).optional(),
  context: z.string().min(1).max(MAX_CONTEXT_LEN).optional(),
  cli: z.enum(["claude", "cursor", "opencode"]).optional(),
  model: z.string().max(MAX_MODEL_LEN).optional(),
});

function generateId(): string {
  return `mode-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeModelField(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const t = model.trim();
  return t.length > 0 ? t : undefined;
}

/** Delegates to the plugin — no CLI-specific logic here. */
async function fetchCliModelsUncached(cli: CliId): Promise<{ models: string[]; error?: string }> {
  return resolvePlugin(cli).listModels();
}

/** Exported for tests; uses TTL cache + in-flight deduplication for all CLIs. */
export async function resolveCliModels(cli: CliId): Promise<{ models: string[]; error?: string }> {
  const hit = cliModelCache.get(cli);
  if (hit && Date.now() - hit.fetchedAt < CLI_MODEL_CACHE_TTL_MS) {
    return { models: hit.models };
  }

  // Deduplicate concurrent fetches for the same CLI
  const inflight = cliModelInflight.get(cli);
  if (inflight) return inflight;

  const fetchPromise = fetchCliModelsUncached(cli).then((result) => {
    cliModelInflight.delete(cli);
    if (!result.error) {
      cliModelCache.set(cli, { models: result.models, fetchedAt: Date.now() });
    }
    return result;
  });
  cliModelInflight.set(cli, fetchPromise);
  return fetchPromise;
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
  // GET /cli-models?cli=
  app.get("/cli-models", async (req, reply) => {
    const q = z.enum(["claude", "cursor", "opencode"]).safeParse(
      typeof req.query === "object" && req.query !== null && "cli" in req.query
        ? (req.query as { cli?: string }).cli
        : undefined,
    );
    if (!q.success) {
      return reply.status(400).send({ error: "Invalid or missing cli query param" });
    }
    const body = await resolveCliModels(q.data);
    return reply.send(body);
  });

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
    const { name, cli, context } = result.data;
    const modelNorm = normalizeModelField(result.data.model);

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
      ...(modelNorm ? { model: modelNorm } : {}),
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
    const { name, context, cli, model } = result.data;

    const modes = await loadModes();
    const idx = modes.findIndex((m) => m.id === id);
    if (idx === -1) return reply.status(404).send({ error: `Mode '${id}' not found` });

    if (name && modes.some((m, i) => i !== idx && m.name === name)) {
      return reply.status(409).send({ error: `A mode named '${name}' already exists.` });
    }

    const prev = modes[idx]!;
    const updated: Mode = { ...prev };
    if (name) updated.name = name;
    if (context) updated.context = context;
    if (cli !== undefined) updated.cli = cli;
    if (model !== undefined) {
      const m = normalizeModelField(model);
      if (m) updated.model = m;
      else delete updated.model;
    }
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
