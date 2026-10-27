import type { MentionKind } from "@/api/types";
import { MENTION_KINDS } from "./kinds";

export interface ParsedMentionQuery {
  scope: MentionKind | null;
  query: string;
  scopeKinds: MentionKind[];
  raw: string;
}

// Derived from the kind registry (singular and section names, e.g. file|files).
const SCOPE_NAMES = MENTION_KINDS.flatMap((k) => [k.section, k.singular]).sort((x, y) => y.length - x.length);
const SCOPE_REGEX = new RegExp(`^(${SCOPE_NAMES.join("|")}):(.*)$`, "i");

export function parseMentionQuery(raw: string): ParsedMentionQuery {
  const match = raw.match(SCOPE_REGEX);
  if (match) {
    const prefix = match[1]!.toLowerCase();
    const scope: MentionKind =
      MENTION_KINDS.find((k) => k.section === prefix || k.singular === prefix)?.kind ?? "file";

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
