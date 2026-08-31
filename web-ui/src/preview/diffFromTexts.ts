// diffFromTexts.ts — Decision 3. Maps jsdiff's Change[] (added/removed/neither,
// each covering 1+ lines via `.value`) onto the SAME DiffHunk/DiffLine shape
// DiffView already renders, as ONE synthetic hunk (no @@ header math needed —
// jsdiff diffs the whole file, there's no "hunk" boundary concept to preserve).
import { diffLines } from "diff";
import type { DiffHunk, DiffLine } from "./diffParser";

export function diffLinesToHunks(oldText: string, newText: string): DiffHunk[] {
  const changes = diffLines(oldText, newText);
  const lines: DiffLine[] = [];
  let oldNum = 1, newNum = 1;
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
  return [{ header: `@@ -1,${oldNum - 1} +1,${newNum - 1} @@`, lines }];
}
