/**
 * Generate a 1-6 char project prefix from a project id.
 * Mirrors AO's generateSessionPrefix from ao:packages/core/src/paths.ts:64-87.
 *
 * Rules:
 * 1. ≤4 chars: use as-is (lowercase, max 6)
 * 2. CamelCase: extract uppercase letters (PyTorch → pt)
 * 3. kebab/snake case: use initials (agent-orchestrator → ao)
 * 4. Single word: first 3 chars (integrator → int)
 *
 * Always returns lowercase alnum only, capped at 6 chars.
 */
export function generateProjectPrefix(projectId: string): string {
  // Strip non-alnum before processing
  const id = projectId.replace(/[^a-zA-Z0-9_-]/g, "").trim() || "proj";

  let prefix: string;

  if (id.length <= 4) {
    prefix = id;
  } else {
    // CamelCase: extract uppercase letters
    const uppercase = id.match(/[A-Z]/g);
    if (uppercase && uppercase.length > 1) {
      prefix = uppercase.join("");
    } else if (id.includes("-") || id.includes("_")) {
      // kebab-case or snake_case: use initials
      const separator = id.includes("-") ? "-" : "_";
      prefix = id
        .split(separator)
        .map((word) => word[0] ?? "")
        .join("");
    } else {
      // Single word: first 3 characters
      prefix = id.slice(0, 3);
    }
  }

  // Lowercase, strip non-alnum, cap at 6
  prefix = prefix.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!prefix) prefix = id.slice(0, 3).toLowerCase().replace(/[^a-z0-9]/g, "") || "pr";
  return prefix.slice(0, 6);
}

/**
 * Disambiguate a base prefix against already-used ones by appending a numeric
 * suffix (tes → tes2 → tes3 …), keeping within the 6-char cap. The prefix is an
 * internal handle (worktree ids / tmux names), so collisions should resolve
 * silently rather than block project creation.
 */
export function makeUniquePrefix(base: string, isTaken: (prefix: string) => boolean): string {
  if (!isTaken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = String(n);
    // Trim the base so base+suffix still fits in 6 chars (min 1 char of base).
    const stem = base.slice(0, Math.max(1, 6 - suffix.length));
    const candidate = stem + suffix;
    if (!isTaken(candidate)) return candidate;
  }
  // Pathological — 998 collisions on one stem. Returning a taken prefix would
  // corrupt worktree ids / tmux names, so fail loudly (caller → 500) instead.
  throw new Error(`Unable to allocate a unique prefix for '${base}'`);
}
