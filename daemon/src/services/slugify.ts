/**
 * Convert a display name into a slug suitable for use as a project id.
 * Rules: lowercase, replace spaces/special chars with hyphens, collapse consecutive hyphens,
 * strip leading/trailing hyphens AND dots.
 *
 * Stripping leading/trailing dots is a hard safety requirement, not cosmetics:
 * the id is used to build filesystem paths (`projectDir(id)`), so a slug of
 * "." or ".." would resolve to `~/.vibe-station` or its parent and a later
 * `DELETE /projects/:id` could `rm -rf` the whole data dir. Internal dots
 * (e.g. "foo.bar") are preserved; a name that is all dots/hyphens falls back
 * to "project".
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64)
    || "project";
}

/**
 * A project id is used to build filesystem paths (`projectDir(id)`), so it must
 * be a single path segment and never a dot-only traversal token. `slugify`
 * already guarantees this, but callers validate the final id as defense in
 * depth before it is persisted or fed to a delete.
 */
export function isSafeProjectId(id: string): boolean {
  return id.length > 0 && id !== "." && id !== ".." && !/[\\/]/.test(id);
}
