// @ts-nocheck
/**
 * Convert a display name into a slug suitable for use as a project id.
 * Rules: lowercase, replace spaces/special chars with hyphens, collapse consecutive hyphens,
 * strip leading/trailing hyphens.
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    || "project";
}
