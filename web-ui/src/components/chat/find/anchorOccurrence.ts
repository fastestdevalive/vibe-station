import type { NormalizedEvent, TranscriptSearchScope } from "@/api/types";
import { docInScope, findDocs, locate } from "@/lib/findTerms";

export interface AnchorOccurrence {
  /** Position of the match among every indexed occurrence inside the anchor's row, in document order. */
  ordinal: number;
  /** Number of indexed occurrences inside the anchor's row. */
  expected: number;
}

/**
 * Maps a server match (`seq`, `occurrence` within its indexed document) to its
 * position among all indexed occurrences that render inside `anchor`, using the
 * same documents the index holds (`findDocs`). The rendered row marks its own
 * visible text, which can differ from the indexed text (a markdown link's URL,
 * JSON keys of a tool input, a path shown as its basename), so callers compare
 * `expected` with the marks actually rendered and outline the row instead when
 * the two disagree. Returns null when the match's document is not loaded.
 */
export function anchorOccurrence(
  events: NormalizedEvent[],
  terms: string[],
  scope: TranscriptSearchScope,
  seqAnchor: (seq: number) => string | undefined,
  anchor: string,
  match: { seq: number; occurrence: number },
): AnchorOccurrence | null {
  if (terms.length === 0) return null;
  let before = 0;
  let ordinal: number | null = null;
  for (const doc of findDocs(events)) {
    if (!docInScope(doc.kind, scope)) continue;
    if (!doc.seqs.some((s) => seqAnchor(s) === anchor)) continue;
    const count = locate(doc.text, terms).length;
    if (ordinal == null && doc.seqs.includes(match.seq)) {
      if (match.occurrence >= count) return null;
      ordinal = before + match.occurrence;
    }
    before += count;
  }
  return ordinal == null ? null : { ordinal, expected: before };
}
