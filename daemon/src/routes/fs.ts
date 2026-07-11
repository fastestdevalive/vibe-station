/**
 * Filesystem autocomplete route — GET /fs/complete
 *
 * Backs the New Project dialog's "Directory" combobox with live filesystem
 * suggestions. Read-only, directories-only, capped, and defensive: the
 * daemon binds to 127.0.0.1 and is auth-gated, but this endpoint browses the
 * host filesystem so it stays conservative about what it exposes.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

const MAX_ENTRIES = 50;

const QuerySchema = z.object({
  path: z.string().max(4096),
});

/**
 * Resolve a leading `~` (either exactly `~` or `~/...`) to the user's home
 * dir. `path.join()` normalizes away a trailing separator, which would
 * silently turn `~/` into `/home/user` (no trailing slash) and break the R4
 * "ends with separator → list children" rule for the common home-dir case —
 * so a trailing separator on the input is restored on the output.
 */
function expandTilde(input: string): string {
  if (input === "~") return homedir();
  if (!(input.startsWith(`~${sep}`) || input.startsWith("~/"))) return input;
  const rest = input.slice(2);
  const joined = join(homedir(), rest);
  const hadTrailingSep = input.endsWith(sep) || input.endsWith("/");
  return hadTrailingSep && !joined.endsWith(sep) ? joined + sep : joined;
}

export function registerFsRoutes(app: FastifyInstance): void {
  // GET /fs/complete?path=<partial>
  app.get("/fs/complete", async (req, reply) => {
    const result = QuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply.status(400).send({ error: "Validation error", details: result.error.issues });
    }
    const { path: rawPath } = result.data;

    if (rawPath.includes("\0")) {
      return reply.status(400).send({ error: "Path cannot contain a null byte." });
    }

    const resolved = expandTilde(rawPath);
    if (!isAbsolute(resolved)) {
      return reply.status(400).send({ error: `Path must be absolute (or start with ~). Got: '${rawPath}'` });
    }

    // R4: only list children of the typed dir when the text ends with the
    // path separator. Otherwise prefix-match child names of the parent dir —
    // do NOT auto-descend just because the text already equals a dir name.
    let dir: string;
    let prefix: string;
    if (resolved.endsWith(sep)) {
      dir = resolved;
      prefix = "";
    } else {
      dir = dirname(resolved);
      prefix = basename(resolved);
    }

    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      // ENOENT/EACCES/etc — user is mid-typing, never 500.
      return reply.send({ base: dir, entries: [] });
    }

    // Cap BEFORE statting symlink dirents so a huge directory can't trigger
    // thousands of stat() calls — take the first N matching-by-name dirents,
    // then resolve which of those are actually directories.
    const candidates = dirents
      .filter((d) => prefix === "" || d.name.startsWith(prefix))
      .slice(0, MAX_ENTRIES);

    const entries: { name: string; path: string }[] = [];
    for (const d of candidates) {
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        entries.push({ name: d.name, path: full });
      } else if (d.isSymbolicLink()) {
        try {
          const s = await stat(full);
          if (s.isDirectory()) entries.push({ name: d.name, path: full });
        } catch {
          // Broken symlink — skip.
        }
      }
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return reply.send({ base: dir, entries });
  });
}
