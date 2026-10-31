import type { MentionKind } from "@/api/types";
import { MENTION_KINDS } from "./kinds";

export interface MentionProjectRef {
  id: string;
  name: string;
}

/** `@worktrees:<project>:<q>` / `@agents:<project>:<q>` — the project half has been picked. */
export interface ProjectScope {
  /** Every project sharing the typed name (names are not unique). */
  projectIds: string[];
  projectName: string;
}

export interface ParsedMentionQuery {
  scope: MentionKind | null;
  /** The text to filter on. For a project-qualified worktree query this is
   *  only the part after the project (`@worktrees:proj:wt` -> `wt`). */
  query: string;
  projectScope?: ProjectScope | null;
  scopeKinds: MentionKind[];
  raw: string;
}

// Derived from the kind registry (singular and section names, e.g. file|files).
const SCOPE_NAMES = MENTION_KINDS.flatMap((k) => [k.section, k.singular]).sort((x, y) => y.length - x.length);
const SCOPE_REGEX = new RegExp(`^(${SCOPE_NAMES.join("|")}):(.*)$`, "i");

/** Kinds searchable across projects via `@<section>:<project>:<filter>`. */
export const CROSS_PROJECT_KINDS: readonly MentionKind[] = ["worktree", "agent"];

/**
 * Splits `<project>:<filter>` using the LONGEST project name that prefixes
 * the query (case-insensitive) — names may themselves contain `:` or spaces.
 * Null when no known project name is followed by a colon.
 */
export function splitProjectQuery(
  query: string,
  projects: readonly MentionProjectRef[],
): { scope: ProjectScope; rest: string } | null {
  const lower = query.toLowerCase();
  let best: string | null = null;
  for (const p of projects) {
    const n = p.name.toLowerCase();
    if (n && lower.startsWith(`${n}:`) && (best === null || n.length > best.length)) best = n;
  }
  if (best === null) return null;
  const matching = projects.filter((p) => p.name.toLowerCase() === best);
  return {
    scope: { projectIds: matching.map((p) => p.id), projectName: matching[0]!.name },
    rest: query.slice(best.length + 1),
  };
}

export function parseMentionQuery(raw: string, projects: readonly MentionProjectRef[] = []): ParsedMentionQuery {
  const match = raw.match(SCOPE_REGEX);
  if (match) {
    const prefix = match[1]!.toLowerCase();
    const scope: MentionKind =
      MENTION_KINDS.find((k) => k.section === prefix || k.singular === prefix)?.kind ?? "file";

    if (CROSS_PROJECT_KINDS.includes(scope)) {
      const split = splitProjectQuery(match[2]!, projects);
      if (split) {
        return { scope, query: split.rest, projectScope: split.scope, scopeKinds: [], raw };
      }
    }

    return {
      scope,
      query: match[2]!,
      scopeKinds: [],
      raw,
    };
  }

  let scopeKinds: MentionKind[] = [];
  if (raw === "") {
    scopeKinds = MENTION_KINDS.map((k) => k.kind);
  } else {
    const lower = raw.toLowerCase();
    scopeKinds = MENTION_KINDS.filter(
      (k) => k.singular.toLowerCase().startsWith(lower) || k.section.toLowerCase().startsWith(lower),
    ).map((k) => k.kind);
  }

  return {
    scope: null,
    query: raw,
    scopeKinds,
    raw,
  };
}
