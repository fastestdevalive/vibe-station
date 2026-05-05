// @ts-nocheck
/**
 * In-memory project store.
 *
 * Boot-time: call loadAll() to populate the map from disk.
 * All reads are pure memory.
 * All mutations go through mutateProject() which writes manifest atomically.
 *
 * HIGH-LEVEL-DESIGN.md §3 compliance:
 *  - Reads: NEVER touch disk during request handling.
 *  - Writes: immediate atomic write for structural changes.
 *  - Per-project mutex: via withProjectLock in each mutation.
 */

import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectRecord } from "../types.js";
import { readManifest, writeManifest } from "../services/manifest.js";
import { withProjectLock } from "../services/mutex.js";
import { vstHome } from "../services/paths.js";

const store = new Map<string, ProjectRecord>();

/**
 * Walk ~/.vibe-station/projects/[id]/manifest.json and load each into memory.
 * Called once at daemon boot.
 */
export async function loadAll(): Promise<void> {
  const projectsDir = join(vstHome(), "projects");

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    // Projects dir doesn't exist yet — nothing to load
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const manifestFile = join(projectsDir, entry, "manifest.json");
      try {
        await access(manifestFile);
        const record = await readManifest(entry);
        store.set(record.id, record);
      } catch {
        // Malformed or missing manifest — skip silently
      }
    }),
  );
}

/** Get a project record from memory. Returns undefined if not found. */
export function getProject(id: string): ProjectRecord | undefined {
  return store.get(id);
}

/** Returns all project records as an array. */
export function getAllProjects(): ProjectRecord[] {
  return Array.from(store.values());
}

/**
 * Atomically mutate a project and persist its manifest.
 * The mutation function receives the current record and MUST return the updated record.
 * If the project doesn't exist, throws an error.
 */
export async function mutateProject(
  id: string,
  fn: (record: ProjectRecord) => ProjectRecord,
): Promise<ProjectRecord> {
  return withProjectLock(id, async () => {
    const existing = store.get(id);
    if (!existing) {
      throw new Error(`Project '${id}' not found`);
    }
    const updated = fn(existing);
    store.set(id, updated);
    await writeManifest(updated);
    return updated;
  });
}

/**
 * Add a new project to the store and persist its manifest.
 * Throws if a project with the same id already exists.
 */
export async function addProject(record: ProjectRecord): Promise<void> {
  return withProjectLock(record.id, async () => {
    if (store.has(record.id)) {
      throw new Error(`Project '${record.id}' already exists`);
    }
    store.set(record.id, record);
    await writeManifest(record);
  });
}

/**
 * Remove a project from memory and its manifest from disk.
 * Does NOT clean up worktree directories or tmux sessions — caller must do that.
 */
export async function deleteProject(id: string): Promise<void> {
  return withProjectLock(id, async () => {
    if (!store.has(id)) {
      throw new Error(`Project '${id}' not found`);
    }
    store.delete(id);
    // Disk cleanup (full directory removal) is handled by the route handler.
  });
}

/** For testing: clear all state. */
export function _clearStoreForTest(): void {
  store.clear();
}
