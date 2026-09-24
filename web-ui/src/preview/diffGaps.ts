import type { DiffHunk } from "./diffParser";

/** A gap is the [start,end] new-file line range git omitted between two hunks
 *  (or before the first / after the last). Derived from each hunk's first/last
 *  `newLineNumber`, not from re-parsing `hunk.header` — the only field every
 *  hunk source (`diffLinesToHunks`, `parseUnifiedDiff`,
 *  `syntheticUntrackedHunks`) guarantees on every `DiffLine`. */
export interface DiffGap {
  id: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  /** New-line-number → old-line-number offset for this gap's range (a gap is
   *  pure unchanged context, so this shift is constant across it). Add to a
   *  line in `[startLine, endLine]` to get its old-side line number. */
  oldOffset: number;
}

/** Net new-vs-old line-count shift contributed by one hunk — added lines
 *  push everything after them forward, removed lines pull it back. Counting
 *  line types directly (not the hunk header, which `diffLinesToHunks` never
 *  produces) keeps this correct for every hunk source. */
function hunkLineDelta(hunk: DiffHunk): number {
  let delta = 0;
  for (const l of hunk.lines) {
    if (l.type === "added") delta += 1;
    else if (l.type === "removed") delta -= 1;
  }
  return delta;
}

/** Returns the gaps (omitted line ranges) for a set of hunks, or `[]` when
 *  `fileLines` is unavailable — callers must treat that as "no gap
 *  affordance," not an error. */
export function computeGaps(hunks: DiffHunk[], fileLines: string[] | null): DiffGap[] {
  if (!fileLines || hunks.length === 0) return [];
  const gaps: DiffGap[] = [];
  const firstNew = hunks[0]!.lines.find((l) => l.newLineNumber != null)?.newLineNumber ?? 1;
  // Before the first hunk, no hunk has run yet — old and new numbering are
  // still identical (offset 0), regardless of what the file changes later on.
  if (firstNew > 1) {
    gaps.push({ id: "gap-start", startLine: 1, endLine: firstNew - 1, lineCount: firstNew - 1, oldOffset: 0 });
  }
  let cumulativeDelta = 0;
  for (let i = 0; i < hunks.length - 1; i++) {
    cumulativeDelta += hunkLineDelta(hunks[i]!);
    const endOfThis = [...hunks[i]!.lines].reverse().find((l) => l.newLineNumber != null)?.newLineNumber;
    const startOfNext = hunks[i + 1]!.lines.find((l) => l.newLineNumber != null)?.newLineNumber;
    if (endOfThis != null && startOfNext != null && startOfNext - endOfThis > 1) {
      gaps.push({
        id: `gap-${i}`,
        startLine: endOfThis + 1,
        endLine: startOfNext - 1,
        lineCount: startOfNext - endOfThis - 1,
        oldOffset: 0 - cumulativeDelta,
      });
    }
  }
  const lastHunk = hunks[hunks.length - 1]!;
  cumulativeDelta += hunkLineDelta(lastHunk);
  const lastNew = [...lastHunk.lines].reverse().find((l) => l.newLineNumber != null)?.newLineNumber ?? fileLines.length;
  if (lastNew < fileLines.length) {
    gaps.push({
      id: "gap-end",
      startLine: lastNew + 1,
      endLine: fileLines.length,
      lineCount: fileLines.length - lastNew,
      oldOffset: 0 - cumulativeDelta,
    });
  }
  return gaps;
}
