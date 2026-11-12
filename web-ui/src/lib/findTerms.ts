import type { NormalizedEvent } from "@/api/types";

/**
 * Terms rule:
 * 1. `trimmed = q.trim()`; invalid when empty or longer than 200 scalars.
 * 2. `words = trimmed` split on Unicode whitespace.
 * 3. `terms =` words of >=3 scalars, de-duplicated after folding.
 * 4. If `terms` is empty: when `trimmed` has >=3 scalars use `[trimmed]` (one phrase, spaces included),
 *    otherwise the query is server-invalid and clients search the loaded window with `[trimmed]`.
 */
export function findTerms(q: string): string[] {
  const trimmed = q.trim();
  const scalarCount = Array.from(trimmed).length;
  if (scalarCount === 0 || scalarCount > 200) {
    return [];
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const longWords = words.filter((w) => Array.from(w).length >= 3);

  if (longWords.length > 0) {
    const seenFolded = new Set<string>();
    const terms: string[] = [];
    for (const w of longWords) {
      const f = fold(w).folded;
      if (!seenFolded.has(f)) {
        seenFolded.add(f);
        terms.push(w);
      }
    }
    return terms;
  }

  return [trimmed];
}

/**
 * Folds text according to SQLite FTS5 `trigram remove_diacritics 1`:
 * - Case-insensitive
 * - Diacritics removed for Latin (e.g. café -> cafe, Résumé -> resume, ệ -> e)
 * - Turkish İ (U+0130) -> i
 * - German ß -> ß (not expanded to ss)
 * - Cyrillic lowercased (e.g. й -> й, not stripped)
 * - CJK and emojis preserved
 *
 * Returns `{ folded, map }` where `map[i]` is the UTF-16 code unit offset in `s`
 * corresponding to index `i` in `folded`, ending with `map[folded.length] = s.length`.
 */
export function fold(s: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let i = 0;

  while (i < s.length) {
    const startIdx = i;
    const cp = s.codePointAt(i)!;
    const cpLen = cp > 0xffff ? 2 : 1;
    let ch = s.slice(i, i + cpLen);
    i += cpLen;

    // Consume combining marks
    while (i < s.length) {
      const nextCp = s.codePointAt(i)!;
      const nextLen = nextCp > 0xffff ? 2 : 1;
      const nextCh = s.slice(i, i + nextLen);
      if (/\p{M}/u.test(nextCh)) {
        ch += nextCh;
        i += nextLen;
      } else {
        break;
      }
    }

    let foldedCh: string;
    if (ch === "\u0130" || ch === "I\u0307") {
      foldedCh = "i";
    } else if (/\p{Script=Cyrillic}/u.test(ch)) {
      foldedCh = ch.toLowerCase();
    } else {
      foldedCh = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    }

    for (let f = 0; f < foldedCh.length; f++) {
      map.push(startIdx);
      folded += foldedCh[f];
    }
  }

  map.push(s.length);
  return { folded, map };
}

/**
 * Locates all occurrences of terms in `text`.
 * Rules 5-7:
 * - A document matches only when it contains every term.
 * - Occurrences = all term matches sorted by start, overlapping/adjacent ranges merged.
 * - Returns UTF-16 offsets [start, end].
 */
export function locate(text: string, terms: string[]): Array<[number, number]> {
  if (!text || !terms || terms.length === 0) return [];

  const { folded, map } = fold(text);
  const foldedTerms = terms.map((t) => fold(t).folded).filter(Boolean);
  if (foldedTerms.length === 0) return [];

  // Rule 6: document matches only when it contains EVERY term
  const termMatches: Array<[number, number]> = [];
  for (const ft of foldedTerms) {
    let pos = 0;
    let found = false;
    while (pos <= folded.length - ft.length) {
      const idx = folded.indexOf(ft, pos);
      if (idx === -1) break;
      found = true;
      const startInOriginal = map[idx]!;
      const endInOriginal = map[idx + ft.length]!;
      termMatches.push([startInOriginal, endInOriginal]);
      pos = idx + 1;
    }
    if (!found) {
      return [];
    }
  }

  if (termMatches.length === 0) return [];

  // Rule 7: sort by start, then end; merge overlapping / adjacent ranges
  termMatches.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: Array<[number, number]> = [termMatches[0]!];
  for (let i = 1; i < termMatches.length; i++) {
    const cur = termMatches[i]!;
    const last = merged[merged.length - 1]!;
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }

  return merged;
}

function extractStringValues(val: unknown, out: string[]): void {
  if (typeof val === "string") {
    out.push(val);
  } else if (Array.isArray(val)) {
    for (const item of val) extractStringValues(item, out);
  } else if (val && typeof val === "object") {
    for (const v of Object.values(val as Record<string, unknown>)) {
      extractStringValues(v, out);
    }
  }
}

/**
 * Boundary contract § Document / Indexed text:
 * - `user` / `text` / `thinking` -> `text`
 * - `tool_use` -> tool name + every string value inside `toolInput` (keys excluded), newline-joined, cut at 3072 chars
 * - `tool_result` -> `toolResult.content`, cut at 3072 chars
 * - superseded rows, silent user rows, and all other kinds -> `null`
 */
export function eventFindText(
  ev: NormalizedEvent,
): { kind: "user" | "text" | "thinking" | "tool_use" | "tool_result"; text: string } | null {
  if (ev.superseded) return null;

  if (ev.kind === "user") {
    if (ev.silent) return null;
    return { kind: "user", text: ev.text ?? "" };
  }

  if (ev.kind === "text") {
    return { kind: "text", text: ev.text ?? "" };
  }

  if (ev.kind === "thinking") {
    return { kind: "thinking", text: ev.text ?? "" };
  }

  if (ev.kind === "tool_use") {
    const strValues: string[] = [];
    if (ev.toolInput != null) {
      extractStringValues(ev.toolInput, strValues);
    }
    const parts = [ev.toolName ?? "", ...strValues].filter(Boolean);
    let full = parts.join("\n");
    if (full.length > 3072) {
      full = full.slice(0, 3072);
    }
    return { kind: "tool_use", text: full };
  }

  if (ev.kind === "tool_result") {
    let full = ev.toolResult?.content ?? "";
    if (full.length > 3072) {
      full = full.slice(0, 3072);
    }
    return { kind: "tool_result", text: full };
  }

  return null;
}

/** One indexed document: a contiguous text/thinking run of one turn, or a single row. */
export interface FindDoc {
  kind: "user" | "text" | "thinking" | "tool_use" | "tool_result";
  text: string;
  /** `logSeq` of every row folded into this document (rows without one are omitted). */
  seqs: number[];
}

/** Splits `events` into the documents the search index holds, in transcript order. */
export function findDocs(events: NormalizedEvent[]): FindDoc[] {
  const docs: FindDoc[] = [];
  let currentRun: { kind: "text" | "thinking"; turnId?: string; texts: string[]; seqs: number[] } | null = null;

  function flushRun() {
    if (!currentRun) return;
    docs.push({ kind: currentRun.kind, text: currentRun.texts.join(""), seqs: currentRun.seqs });
    currentRun = null;
  }

  for (const ev of events) {
    const findInfo = eventFindText(ev);
    if (!findInfo) {
      flushRun();
      continue;
    }
    const seqs = ev.logSeq != null ? [ev.logSeq] : [];

    if (findInfo.kind === "text" || findInfo.kind === "thinking") {
      if (
        currentRun &&
        currentRun.kind === findInfo.kind &&
        currentRun.turnId === ev.turnId
      ) {
        currentRun.texts.push(findInfo.text);
        currentRun.seqs.push(...seqs);
      } else {
        flushRun();
        currentRun = {
          kind: findInfo.kind,
          turnId: ev.turnId,
          texts: [findInfo.text],
          seqs,
        };
      }
    } else {
      flushRun();
      docs.push({ kind: findInfo.kind, text: findInfo.text, seqs });
    }
  }
  flushRun();
  return docs;
}

/** Whether a document of `kind` is searched under `scope`. */
export function docInScope(kind: FindDoc["kind"], scope: "messages" | "all"): boolean {
  return scope === "all" || kind === "user" || kind === "text";
}

/**
 * Counts local match occurrences across `events` for the given terms and scope.
 */
export function countLocal(
  events: NormalizedEvent[],
  terms: string[],
  scope: "messages" | "all" = "messages",
): number {
  if (!events || events.length === 0 || !terms || terms.length === 0) return 0;

  let count = 0;
  for (const doc of findDocs(events)) {
    if (!docInScope(doc.kind, scope)) continue;
    count += locate(doc.text, terms).length;
  }
  return count;
}
