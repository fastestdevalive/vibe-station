import type { DiffLine } from "./diffParser";

/** One paired row in the side-by-side layout: context lines mirror on both
 *  sides; a removed/added run pairs index-wise, `null`-padding the shorter
 *  side (Decision 3). */
export interface SideBySideRow {
  key: string;
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Buckets a hunk's flat `DiffLine[]` into side-by-side rows. Context lines
 *  mirror both columns; each consecutive removed-run followed by added-run
 *  (unified diff's actual emission order) pairs index-wise into
 *  `Math.max(removed.length, added.length)` rows. Pure — no state, no new
 *  diff algorithm, just a re-bucketing of already-parsed lines. */
export function pairHunkLines(lines: DiffLine[], hunkIndex: number): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === "context") {
      rows.push({ key: `${hunkIndex}-${n++}`, left: line, right: line });
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === "removed") {
      removed.push(lines[i]!);
      i++;
    }
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === "added") {
      added.push(lines[i]!);
      i++;
    }
    const max = Math.max(removed.length, added.length);
    for (let k = 0; k < max; k++) {
      rows.push({ key: `${hunkIndex}-${n++}`, left: removed[k] ?? null, right: added[k] ?? null });
    }
  }
  return rows;
}
