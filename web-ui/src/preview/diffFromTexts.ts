// diffFromTexts.ts — Decision 3. Maps jsdiff's Change[] (added/removed/neither,
// each covering 1+ lines via `.value`) onto the SAME DiffHunk/DiffLine shape
// DiffView already renders, as ONE synthetic hunk (jsdiff diffs the two texts
// handed to it, so there's no "hunk" boundary concept to preserve).
//
// `oldStart`/`newStart` are the 1-based line numbers of the supplied texts'
// first lines within their ORIGINAL files. The daemon trims a whole-file edit
// diff into per-hunk `ToolDiff`s that already carry their real offsets
// (`vst-diff`), so numbering must continue from there — not from 1, which
// would show every hunk as if it started at the top of the file. A diff with
// no starts (untrimmed whole file, claude-style snippet, new-file Write) is
// numbered from line 1, which is correct for it.
import { diffLines } from "diff";
import type { DiffHunk, DiffLine } from "./diffParser";

/** Line-terminated split matching the daemon's `split_keep_ends`: only `\n`
 *  ends a line, so a CRLF's `\r` stays attached to its content and the final
 *  line (no trailing newline) still counts. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (const ch of text) if (ch === "\n") count += 1;
  return text.endsWith("\n") ? count : count + 1;
}

export function diffLinesToHunks(
  oldText: string,
  newText: string,
  oldStart = 1,
  newStart = 1,
): DiffHunk[] {
  const changes = diffLines(oldText, newText);
  const lines: DiffLine[] = [];
  let oldNum = oldStart;
  let newNum = newStart;
  for (const part of changes) {
    const type = part.added ? "added" : part.removed ? "removed" : "context";
    // jsdiff keeps trailing "\n" inside `.value`, so split() always leaves a
    // final "" entry EXCEPT for a part with no trailing newline (the file's
    // very last line) — only drop it when it's actually empty, never
    // unconditionally, or the last real line silently disappears.
    const rawLines = part.value.split("\n");
    if (rawLines[rawLines.length - 1] === "") rawLines.pop();
    for (const content of rawLines) {
      lines.push({
        type,
        content,
        oldLineNumber: type === "added" ? null : oldNum++,
        newLineNumber: type === "removed" ? null : newNum++,
      });
    }
  }
  // Counts are the real line counts of each side (jsdiff may have dropped a
  // trailing newline, so `oldNum - oldStart` is one short at EOF). An empty
  // side uses start 0, matching GNU/git unified-diff convention (`-0,0`, not
  // `-1,0`).
  const oldCount = countLines(oldText);
  const newCount = countLines(newText);
  return [
    {
      header: `@@ -${oldCount === 0 ? 0 : oldStart},${oldCount} +${newCount === 0 ? 0 : newStart},${newCount} @@`,
      lines,
    },
  ];
}
