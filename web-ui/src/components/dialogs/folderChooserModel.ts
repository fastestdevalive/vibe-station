/**
 * Pure path helpers for the folder chooser (no React, no I/O). The chooser
 * sends the typed text verbatim; navigated paths carry their own trailing `/`.
 * `~` stays `~` end to end, so Up/descend never build `/~/...`.
 */

export interface FolderEntry {
  name: string;
  path: string;
}

/** Ends with exactly one trailing `/`. */
export function withSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

/** Drops one trailing `/`; a lone `/` is kept. */
export function stripSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The text after the last `/` (what the user is typing right now). */
export function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** True when both texts name the same folder (equal up to and including the last `/`). */
export function sameFolder(a: string, b: string): boolean {
  return a.slice(0, a.lastIndexOf("/") + 1) === b.slice(0, b.lastIndexOf("/") + 1);
}

/** Dot-names are hidden unless the typed last segment starts with a dot. */
export function visibleEntries(raw: FolderEntry[], typed: string): FolderEntry[] {
  const dotTyped = lastSegment(typed).startsWith(".");
  return raw.filter((entry) => dotTyped || !entry.name.startsWith("."));
}

/** Visible entries whose name starts with the typed last segment (case-insensitively). */
export function matchingEntries(raw: FolderEntry[], typed: string): FolderEntry[] {
  const segment = lastSegment(typed).toLowerCase();
  return visibleEntries(raw, typed).filter((entry) => entry.name.toLowerCase().startsWith(segment));
}

/**
 * The inline completion: the first visible entry whose name starts with the
 * typed last segment (case-insensitively) and is longer than it. The remainder
 * ends with `/` (a directory completion, matching what Tab / ArrowRight accept).
 * Null for an empty last segment, an exact match, or no match.
 */
export function ghostFor(
  typed: string,
  entries: FolderEntry[],
): { remainder: string; entry: FolderEntry } | null {
  const segment = lastSegment(typed);
  if (segment === "") return null;
  const entry = visibleEntries(entries, typed)[0];
  if (!entry || entry.name.length <= segment.length) return null;
  if (!entry.name.toLowerCase().startsWith(segment.toLowerCase())) return null;
  return { remainder: `${entry.name.slice(segment.length)}/`, entry };
}

/**
 * The path an entry resolves to: the typed text with its last segment replaced
 * by the entry's own name (so the case is fixed) plus a trailing `/`. A bare
 * `~` keeps its tilde (`~` becomes `~/<name>/`).
 */
export function acceptedPath(typed: string, entry: FolderEntry): string {
  const slash = typed.lastIndexOf("/");
  let head = "";
  if (slash >= 0) head = typed.slice(0, slash + 1);
  else if (typed.startsWith("~")) head = "~/";
  return `${head}${entry.name}/`;
}

/**
 * The parent of a path, keeping its prefix style: `~/a/b/` -> `~/a/`,
 * `~/a/` -> `~/`, `~` -> `~/`, `/a/` -> `/`. Roots map to themselves.
 */
export function parentPath(path: string): string {
  const home = path.startsWith("~");
  const parts = path.split("/").filter(Boolean);
  if (home) parts.shift();
  parts.pop();
  if (home) return parts.length ? `~/${parts.join("/")}/` : "~/";
  return parts.length ? `/${parts.join("/")}/` : "/";
}

/** True when the path has no parent (`/`, `~`, `~/`). */
export function isRoot(path: string): boolean {
  const slashed = withSlash(path);
  return parentPath(slashed) === slashed;
}

/**
 * True when the ghost remainder is not fully inside the field's clipping box:
 * the track (typed text + remainder) minus the input's horizontal scroll is
 * wider than the box. An unmeasurable box (width 0, e.g. jsdom) counts as visible.
 */
export function ghostClipped(trackWidth: number, scrollLeft: number, fieldWidth: number): boolean {
  return fieldWidth > 0 && trackWidth - scrollLeft > fieldWidth;
}

/**
 * Where Browse opens for a typed folder: the folder itself when the last check
 * found it, otherwise its parent (text up to and including the last `/`);
 * `~/` when there is no `/` at all, or nothing typed.
 */
export function chooserSeed(value: string, exists: boolean): string {
  const text = value.trim();
  if (!text.includes("/")) return "~/";
  if (exists) return withSlash(text);
  return text.slice(0, text.lastIndexOf("/") + 1);
}
