import type { MentionKind, SessionState } from "@/api/types";
import { MENTION_KINDS, mentionKindDef } from "./kinds";
import { rankItems } from "./mentionFilter";
import { MAX_MENTION_QUERY_LENGTH } from "./mentionOps";
import { CROSS_PROJECT_KINDS, type ParsedMentionQuery } from "./mentionQuery";

/** Status row shown in the Files group while the daemon builds its first index. */
export const INDEXING_TEXT = "Indexing files…";
export const INDEXING_SLOW_TEXT = "Indexing files… (taking longer than usual)";
const indexingText = (source: SourceResult): string =>
  source.slowIndexing ? INDEXING_SLOW_TEXT : INDEXING_TEXT;

export interface MentionItem {
  kind: MentionKind;
  id: string;
  label: string;
  secondary: string;
  status?: SessionState;
}

export interface SourceResult {
  items: MentionItem[];
  loading?: boolean;
  /** Server is still building its first file index (files group only). */
  indexing?: boolean;
  /** Indexing for >30s: say so rather than falling back to an empty state. */
  slowIndexing?: boolean;
  error?: string | null;
  unavailable?: string;
}

export type MentionRow =
  | {
      type: "scope";
      kind: MentionKind;
      label: string;
      /** Replacement text (without the leading `@`) for the active token when
       *  picked; defaults to `<section>:`. A worktree project-picker row sets
       *  `worktrees:<project>:`. */
      insertRaw?: string;
    }
  | { type: "header"; title: string; caption?: string }
  | { type: "item"; item: MentionItem }
  | { type: "status"; text: string };

export function selectableRows(rows: MentionRow[]): Array<Extract<MentionRow, { type: "scope" | "item" }>> {
  return rows.filter((r): r is Extract<MentionRow, { type: "scope" | "item" }> => r.type === "scope" || r.type === "item");
}

export interface BuildMentionRowsOptions {
  limitReached: boolean;
  /** File target scope; drives the Files group caption. Defaults to "worktree". */
  fileScope?: "worktree" | "project";
  /** The composer's own project; excluded from the worktree project picker
   *  (its worktrees are already listed first). */
  currentProjectId?: string | null;
}

/** Max project-picker rows under `@worktrees:`. */
const PROJECT_PICKER_LIMIT = 5;

/**
 * File items arrive already fuzzy-matched and recency-ranked by the server
 * (no client-side scoring fork): keep their order and never drop rows. Other
 * kinds are small local lists, filtered/scored here.
 */
function rankForKind(kind: MentionKind, items: MentionItem[], query: string): MentionItem[] {
  return kind === "file" ? [...items] : rankItems(items, query);
}

function groupCaption(kind: MentionKind, opts: BuildMentionRowsOptions): string {
  if (kind === "file" && opts.fileScope === "project") return "this project";
  return mentionKindDef(kind).caption;
}

/**
 * `@worktrees:` / `@agents:` rows (kinds in `CROSS_PROJECT_KINDS`). Without a
 * project half: this project's items, then "Other projects" rows that, when
 * picked, rewrite the token to `@<section>:<project>:` (narrowing to that
 * project). With a project half (`@<section>:<project>:<q>`): only that
 * project's items, filtered by `<q>`.
 */
function crossProjectScopedRows(
  kind: MentionKind,
  parsed: ParsedMentionQuery,
  ranked: MentionItem[],
  projectItems: MentionItem[],
  opts: BuildMentionRowsOptions,
): MentionRow[] {
  const { section } = mentionKindDef(kind);
  const rows: MentionRow[] = ranked.slice(0, 10).map((item) => ({ type: "item", item }));

  if (parsed.projectScope) {
    if (rows.length === 0) {
      const name = parsed.projectScope.projectName;
      return [
        {
          type: "status",
          text: parsed.query ? `No ${section} in ${name} match "${parsed.query}"` : `No ${section} in ${name}`,
        },
      ];
    }
    return rows;
  }

  // One picker row per distinct name (names aren't unique and the pick lists
  // every project sharing it), and none whose rewritten token would exceed the
  // query cap (the popover would close right after the pick).
  const seen = new Set<string>();
  const pickable = projectItems.filter((p) => {
    const key = p.label.trim().toLowerCase();
    if (p.id === opts.currentProjectId || key === "" || seen.has(key)) return false;
    if (`${section}:${p.label}:`.length > MAX_MENTION_QUERY_LENGTH) return false;
    seen.add(key);
    return true;
  });
  const projects = rankItems(pickable, parsed.query).slice(0, PROJECT_PICKER_LIMIT);
  if (projects.length > 0) {
    rows.push({ type: "header", title: "Other projects", caption: `Enter to search their ${section}` });
    for (const p of projects) {
      rows.push({
        type: "scope",
        kind,
        label: `@${section}:${p.label}:`,
        insertRaw: `${section}:${p.label}:`,
      });
    }
  }
  if (rows.length === 0) {
    return [{ type: "status", text: `No ${section} match "${parsed.query}"` }];
  }
  return rows;
}

export function buildMentionRows(
  parsed: ParsedMentionQuery,
  sources: Record<MentionKind, SourceResult>,
  opts: BuildMentionRowsOptions,
): MentionRow[] {
  if (opts.limitReached) {
    return [{ type: "status", text: "Mention limit (50) reached" }];
  }

  // Scoped query: @files:foo, @agents:bar, etc.
  if (parsed.scope !== null) {
    const kind = parsed.scope;
    const def = mentionKindDef(kind);
    const source = sources[kind] ?? { items: [] };

    if (source.unavailable) {
      return [{ type: "status", text: source.unavailable || "Choose a project to search files" }];
    }
    if (source.error) {
      return [{ type: "status", text: source.error || "File search failed" }];
    }
    if (source.loading && source.items.length === 0) {
      return [{ type: "status", text: kind === "file" ? "Searching files…" : `Searching ${def.section}…` }];
    }

    const ranked = rankForKind(kind, source.items, parsed.query);

    if (CROSS_PROJECT_KINDS.includes(kind)) {
      return crossProjectScopedRows(kind, parsed, ranked, sources.project?.items ?? [], opts);
    }
    if (ranked.length === 0 && kind === "file" && source.indexing) {
      return [{ type: "status", text: indexingText(source) }];
    }
    if (ranked.length === 0) {
      return [{ type: "status", text: `No ${def.section} match "${parsed.query}"` }];
    }

    // Scoped items: 10 max, no headers
    return ranked.slice(0, 10).map((item) => ({ type: "item", item }));
  }

  // Unscoped query: empty raw (@)
  if (parsed.raw === "") {
    const rows: MentionRow[] = [];
    for (const def of MENTION_KINDS) {
      const source = sources[def.kind] ?? { items: [] };
      const items = source.items.slice(0, 3);
      if (items.length > 0) {
        rows.push({ type: "header", title: def.title, caption: groupCaption(def.kind, opts) });
        for (const item of items) {
          rows.push({ type: "item", item });
        }
      } else if (def.kind === "file" && source.indexing) {
        rows.push({ type: "header", title: def.title, caption: groupCaption(def.kind, opts) });
        rows.push({ type: "status", text: indexingText(source) });
      }
    }

    rows.push({ type: "header", title: "Narrow to" });
    for (const def of MENTION_KINDS) {
      rows.push({ type: "scope", kind: def.kind, label: `@${def.section}:` });
    }
    return rows;
  }

  // Unscoped query with non-empty raw (e.g. @ag, @foo)
  const rows: MentionRow[] = [];
  if (parsed.scopeKinds.length > 0) {
    rows.push({ type: "header", title: "SCOPE", caption: "Enter to search only here" });
    for (const k of parsed.scopeKinds) {
      const def = mentionKindDef(k);
      rows.push({ type: "scope", kind: k, label: `@${def.section}:` });
    }
  }

  // Group order: scope-matching kind first, then remaining kinds
  const orderedKinds: MentionKind[] = [];
  for (const k of parsed.scopeKinds) {
    if (!orderedKinds.includes(k)) orderedKinds.push(k);
  }
  for (const def of MENTION_KINDS) {
    if (!orderedKinds.includes(def.kind)) orderedKinds.push(def.kind);
  }

  let totalItems = 0;
  let sawIndexing = false;
  for (const kind of orderedKinds) {
    const def = mentionKindDef(kind);
    const source = sources[kind] ?? { items: [] };
    const ranked = rankForKind(kind, source.items, parsed.query).slice(0, 3);
    if (ranked.length > 0) {
      rows.push({ type: "header", title: def.title, caption: groupCaption(def.kind, opts) });
      for (const item of ranked) {
        rows.push({ type: "item", item });
        totalItems++;
      }
    } else if (kind === "file" && source.indexing && source.items.length === 0) {
      rows.push({ type: "header", title: def.title, caption: groupCaption(def.kind, opts) });
      rows.push({ type: "status", text: indexingText(source) });
      sawIndexing = true;
    } else if (kind === "file" && source.loading && source.items.length === 0) {
      rows.push({ type: "header", title: def.title, caption: groupCaption(def.kind, opts) });
      rows.push({ type: "status", text: "Searching files…" });
    } else if (kind === "file" && source.error) {
      rows.push({ type: "header", title: def.title, caption: groupCaption(def.kind, opts) });
      rows.push({ type: "status", text: "File search failed" });
    }
  }

  if (totalItems === 0 && !sawIndexing && parsed.scopeKinds.length === 0) {
    return [{ type: "status", text: "No matches" }];
  }

  return rows;
}
