/**
 * User skill catalog — scans configured `skillPaths` directories for
 * `<dir>/<name>/SKILL.md` user skills, watches them for changes (chokidar +
 * debounce, following `ws/streams/fileWatcher.ts:40`'s pattern), and merges
 * them with the ACP `available_commands_update` catalog per-field
 * (skill-invocation-in-chat Decision 7).
 *
 * NOT to be confused with either of the repo's own same-named things (see
 * AGENTS.md, "Three unrelated things named skill"): the repo-root
 * `skill/SKILL.md` is the `vst` agent skill this repo PUBLISHES for external
 * agents, and `daemon/assets/agent-system-prompt.md` is vibe-station's own L1
 * system prompt (loaded by `promptBuilder.ts`). Neither is user-configurable,
 * and neither is scanned from here — but a user who points `skillPaths` at the
 * vibe-station repo root would have this scanner ingest `skill/SKILL.md` as a
 * user skill named `vst` (Decision 10's "scan hazard"); the default
 * (`~/.claude/skills`) avoids this, but the Skills settings UI does not block
 * the repo root either.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { watch, type FSWatcher } from "chokidar";

/** A single scanned `<dir>/<name>/SKILL.md` entry. */
export interface SkillCatalogEntry {
  name: string;
  description?: string;
  argumentHint?: string;
  /** Absolute path to the skill's SKILL.md — directory-scanned entries only. */
  path: string;
}

/** Per-directory scan outcome, surfaced in `GET /skills` (no error status). */
export interface SkillDirectoryStatus {
  path: string;
  skillCount: number;
  /** Set only for a REAL failure (permissions, I/O). A directory that simply
   *  does not exist is reported via `missing`, not here — we ship defaults for
   *  CLIs the user may not have installed. */
  error?: string;
  /** True when the directory is absent (ENOENT). Not a failure. */
  missing?: boolean;
}

/** The shape of an ACP `available_commands_update` catalog entry. */
export interface AcpCommandLike {
  name: string;
  description: string;
  argumentHint?: string;
}

/**
 * A per-field merged catalog entry (Decision 7): on a name collision, ACP
 * wins `description`/`argumentHint`; `path` comes ONLY from the
 * directory-scanned entry and is `undefined` for an ACP-only name (ACP
 * payloads never carry a path at all).
 */
export interface MergedSkillEntry {
  name: string;
  description?: string;
  argumentHint?: string;
  path?: string;
}

const SKILL_FILE = "SKILL.md";
const DEBOUNCE_MS = 200;

/**
 * Parse a SKILL.md's YAML-ish frontmatter defensively (Risk 9 — field names
 * are unverified against real files). Only a bounded `---\n...\n---` block
 * with simple `key: value` lines is understood; anything else (no
 * frontmatter, malformed block) returns `null` rather than throwing.
 */
export function parseSkillFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith("---")) return null;
  const firstLineEnd = content.indexOf("\n");
  if (firstLineEnd === -1) return null;
  const closeIdx = content.indexOf("\n---", firstLineEnd);
  if (closeIdx === -1) return null;
  const block = content.slice(firstLineEnd + 1, closeIdx);
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    // Strip a single layer of matching quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

/**
 * Scan one `skillPaths` directory for `<name>/SKILL.md` skills. Never throws
 * — a missing directory, unreadable subdirectory, or malformed SKILL.md all
 * degrade to a per-directory `error` string with whatever entries could
 * still be parsed (Risk 9).
 */
export async function scanSkillDirectory(
  dir: string,
): Promise<{ entries: SkillCatalogEntry[]; status: SkillDirectoryStatus }> {
  const entries: SkillCatalogEntry[] = [];
  const skipped: string[] = [];

  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // An absent directory is the NORMAL case for a shipped default whose CLI
    // the user has not installed — report it as `missing`, never as an error.
    // ENOENT only. ENOTDIR (the path exists but is a file) is a genuine
    // misconfiguration and stays a visible error.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { entries: [], status: { path: dir, skillCount: 0, missing: true } };
    }
    return {
      entries: [],
      status: {
        path: dir,
        skillCount: 0,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const skillDir = join(dir, dirent.name);
    const skillFile = join(skillDir, SKILL_FILE);
    let content: string;
    try {
      content = await readFile(skillFile, "utf8");
    } catch {
      // No SKILL.md in this subdirectory — not an error, just not a skill.
      continue;
    }
    const frontmatter = parseSkillFrontmatter(content);
    const name = frontmatter?.name;
    if (!frontmatter || !name) {
      skipped.push(skillFile);
      continue;
    }
    entries.push({
      name,
      description: frontmatter.description,
      argumentHint: frontmatter.argumentHint ?? frontmatter["argument-hint"],
      path: skillFile,
    });
  }

  return {
    entries,
    status: {
      path: dir,
      skillCount: entries.length,
      ...(skipped.length > 0
        ? { error: `${skipped.length} skill(s) skipped (missing "name" in frontmatter): ${skipped.join(", ")}` }
        : {}),
    },
  };
}

/**
 * Per-field merge of the ACP catalog with directory-scanned entries
 * (Decision 7). On a name collision, ACP wins `description`/`argumentHint`;
 * `path` is taken ONLY from the directory entry and is `undefined` for an
 * ACP-only name — this is deliberately NOT a per-entry "ACP wins", which
 * would silently drop a directory entry's `path` and break daemon-side
 * resolution (Decision 10).
 */
export function mergeCatalogs(
  acpCommands: AcpCommandLike[] | undefined,
  dirEntries: SkillCatalogEntry[],
): MergedSkillEntry[] {
  const byName = new Map<string, MergedSkillEntry>();

  for (const entry of dirEntries) {
    byName.set(entry.name, {
      name: entry.name,
      description: entry.description,
      argumentHint: entry.argumentHint,
      path: entry.path,
    });
  }

  for (const cmd of acpCommands ?? []) {
    const existing = byName.get(cmd.name);
    byName.set(cmd.name, {
      name: cmd.name,
      // ACP wins on a real (non-empty) value; an ABSENT ACP field — or one
      // present but EMPTY (`normalize.ts` surfaces `input.hint: ""` verbatim,
      // and `description` defaults to `""`) — must not clobber a directory
      // entry's real one. Name collision is the NORMAL case (claude's ACP
      // catalog enumerates the same skills the directory scanner reads), so
      // falling through here is load-bearing, not a rare edge. Both fields use
      // `||`, never `??`, precisely because "" is the empty case that matters.
      description: cmd.description || existing?.description,
      argumentHint: cmd.argumentHint || existing?.argumentHint,
      // path comes ONLY from a directory entry — never from ACP.
      path: existing?.path,
    });
  }

  return [...byName.values()];
}

// ── Singleton state ─────────────────────────────────────────────────────────
//
// One in-memory catalog for the whole daemon process (skills are a global,
// not per-session, resource — report Follow-up #5). Not persisted to disk;
// rebuilt from `skillPaths` on `setSkillPaths`/`refresh` and kept current by
// a debounced chokidar watch per directory.

let currentPaths: string[] = [];
let currentEntries: SkillCatalogEntry[] = [];
let currentDirectories: SkillDirectoryStatus[] = [];
let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function scanAll(paths: string[]): Promise<void> {
  const results = await Promise.all(paths.map((p) => scanSkillDirectory(p)));
  currentEntries = results.flatMap((r) => r.entries);
  currentDirectories = results.map((r) => r.status);
}

function scheduleRescan(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void scanAll(currentPaths);
  }, DEBOUNCE_MS);
}

function startWatching(paths: string[]): Promise<void> {
  stopWatching();
  if (paths.length === 0) return Promise.resolve();
  watcher = watch(paths, {
    persistent: true,
    ignoreInitial: true,
    // No depth cap: skill directories are small and shallow (unlike a git
    // repo's own tree — see `fileWatcher.ts`'s node_modules-exclusion
    // comment), so `<dir>/<skill-name>/SKILL.md` needs to be seen at any depth.
  });
  watcher.on("add", scheduleRescan);
  watcher.on("change", scheduleRescan);
  watcher.on("unlink", scheduleRescan);
  watcher.on("addDir", scheduleRescan);
  watcher.on("unlinkDir", scheduleRescan);
  watcher.on("error", () => {
    // Best-effort — a watch failure just means live updates stop; the last
    // scan result stays in `currentEntries`/`currentDirectories`.
  });
  return new Promise((resolve) => watcher!.once("ready", () => resolve()));
}

function stopWatching(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    void watcher.close();
    watcher = null;
  }
}

/**
 * Rescan + rewatch a new `skillPaths` directory set. Called from
 * `routes/settings.ts` on a `PATCH /settings` that includes `skillPaths`.
 */
export async function setSkillPaths(paths: string[]): Promise<void> {
  currentPaths = [...paths];
  await scanAll(currentPaths);
  await startWatching(currentPaths);
}

/** Rescan the currently-set `skillPaths` without changing the watch set. */
export async function refreshSkillCatalog(): Promise<void> {
  await scanAll(currentPaths);
}

/** Current directory-scanned entries (flattened across all `skillPaths`). */
export function getSkillEntries(): SkillCatalogEntry[] {
  return currentEntries;
}

/** Current per-directory scan status, for `GET /skills`. */
export function getSkillDirectories(): SkillDirectoryStatus[] {
  return currentDirectories;
}

/** The merged view (Decision 7) — ACP catalog overlaid on directory entries. */
export function getMergedSkillCatalog(acpCommands: AcpCommandLike[] | undefined): MergedSkillEntry[] {
  return mergeCatalogs(acpCommands, currentEntries);
}

/** Test-only: stop watchers and reset in-memory state between test cases. */
export function resetSkillCatalogForTests(): void {
  stopWatching();
  currentPaths = [];
  currentEntries = [];
  currentDirectories = [];
}
