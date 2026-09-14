import type { Project } from "@/api/types";
import { ApiError } from "@/api/errors";

/** How the "Project" combobox has been resolved. */
export type Mode_ = "search" | "create" | "add-path" | "existing";

export type ProjectRow =
  | { kind: "create" }
  | { kind: "add-path" }
  | { kind: "path-suggestion"; entry: { name: string; path: string } }
  | { kind: "existing"; project: Project };

export function isAbsoluteQuery(q: string): boolean {
  return q.startsWith("/") || q === "~" || q.startsWith("~/");
}

/** Expand a leading `~` to the real home dir (for API calls / comparisons). */
export function expandHome(p: string, home: string): string {
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

/**
 * Canonical form used for every "is this path already a project?" comparison:
 * `~` expanded and trailing separators stripped, so `~/foo`, `/home/me/foo` and
 * `/home/me/foo/` all resolve to the one string that project.path is stored as.
 */
export function normalizePath(p: string, home: string): string {
  return expandHome(p.trim(), home).replace(/\/+$/, "");
}

export function matchesQuery(p: Project, q: string): boolean {
  if (!q) return true;
  // Strip a trailing separator before matching. Selecting a path-suggestion
  // (or an entry from the Browse dialog) always appends a trailing "/" to
  // the query (R4-style — it lists that directory's children next) — without
  // stripping it here, a query of "/reg/path/" would fail to substring-match
  // a registered project's path "/reg/path" (no trailing slash), leaving the
  // popup with zero rows: no add-path row (alreadyRegistered — which DOES
  // strip trailing slashes — suppresses it) and no matching existing-project
  // row either. A real dead end, not just a cosmetic miss.
  const stripped = q.replace(/\/+$/, "");
  const needle = (stripped || q).toLowerCase();
  return (
    p.name.toLowerCase().includes(needle) ||
    p.id.toLowerCase().includes(needle) ||
    // Match on path too, so typing an already-registered project's absolute
    // path surfaces it in the list instead of a dead-end "create" row.
    p.path.toLowerCase().includes(needle)
  );
}

/**
 * Inline project-name validation for the create-new flow. Covers the daemon's
 * rules (separators / `..` / leading dot) plus a deliberately stricter minimum
 * length — the daemon accepts min 1, but a brand-new project wants a real name,
 * so we require ≥3 chars here.
 */
export function validateProjectName(trimmed: string): string | null {
  if (!trimmed) return "Project name is required.";
  if (trimmed.length < 3) return "Project name must be at least 3 characters.";
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return "Project name cannot contain path separators (/ or \\).";
  }
  if (trimmed.includes("..")) {
    return "Project name cannot contain '..' (path traversal).";
  }
  if (trimmed.startsWith(".")) {
    return "Project name cannot start with a dot.";
  }
  return null;
}

/**
 * Mirrors daemon `branchValidator.ts` rules for fast inline feedback. When the
 * effective base branch is known (create → always "main"; existing → the
 * selected base), a new branch equal to it is rejected as a collision. In
 * add-path mode the base isn't known until the server responds, so `baseBranch`
 * is omitted and the daemon does the collision check.
 *
 * The branch name itself is optional (branch-name-optional) — an empty
 * `trimmed` is valid and means "let the daemon derive one from the prompt, or
 * auto-generate a placeholder." Callers should only invoke this when `trimmed`
 * is non-empty; format/collision rules below only make sense against real input.
 */
export function validateBranchName(trimmed: string, baseBranch?: string): string | null {
  if (!trimmed) return null;
  if (trimmed.length > 200) return "Branch name exceeds 200 character limit.";
  if (trimmed.includes("..")) return 'Branch name cannot contain ".."';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(trimmed)) {
    return "Branch name must start with an alphanumeric character and contain only [a-zA-Z0-9._/-]";
  }
  if (baseBranch && trimmed === baseBranch) {
    return `Branch cannot be '${baseBranch}' — it collides with the base branch.`;
  }
  return null;
}

/**
 * Suggest a worktree branch name that doesn't collide with an existing branch.
 * `git worktree add -b <b>` fails if `<b>` already exists, so defaulting every
 * new worktree to a bare "feature" guarantees a failure on the second one.
 */
export function uniqueBranchName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return base;
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message;
  return String(err);
}
