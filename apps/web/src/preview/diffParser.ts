export interface DiffLine {
  type: "context" | "added" | "removed";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const rawLines = diff.split(/\r?\n/);
  const hunks: DiffHunk[] = [];
  let i = 0;

  while (i < rawLines.length && !rawLines[i]?.startsWith("@@")) {
    i++;
  }

  while (i < rawLines.length) {
    const line = rawLines[i];
    if (!line?.startsWith("@@")) {
      i++;
      continue;
    }

    const header = line;
    const m = line.match(HUNK_HEADER_RE);
    if (!m) {
      i++;
      continue;
    }

    let oldNum = parseInt(m[1] ?? "0", 10);
    let newNum = parseInt(m[3] ?? "0", 10);
    i++;

    const lines: DiffLine[] = [];
    while (i < rawLines.length && !rawLines[i]?.startsWith("@@")) {
      const l = rawLines[i];
      if (!l) break;
      if (l.startsWith("\\")) {
        i++;
        continue;
      }

      if (l === "") {
        lines.push({
          type: "context",
          content: "",
          oldLineNumber: oldNum,
          newLineNumber: newNum,
        });
        oldNum++;
        newNum++;
        i++;
        continue;
      }

      const prefix = l[0];
      const rest = l.slice(1);

      if (prefix === "+") {
        lines.push({
          type: "added",
          content: rest,
          oldLineNumber: null,
          newLineNumber: newNum,
        });
        newNum++;
      } else if (prefix === "-") {
        lines.push({
          type: "removed",
          content: rest,
          oldLineNumber: oldNum,
          newLineNumber: null,
        });
        oldNum++;
      } else if (prefix === " ") {
        lines.push({
          type: "context",
          content: rest,
          oldLineNumber: oldNum,
          newLineNumber: newNum,
        });
        oldNum++;
        newNum++;
      } else {
        i++;
        continue;
      }
      i++;
    }

    hunks.push({ header, lines });
  }

  return hunks;
}

/** Count added / removed lines across parsed hunks (for UI summaries). */
export function summarizeDiffLines(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.type === "added") additions += 1;
      else if (line.type === "removed") deletions += 1;
    }
  }
  return { additions, deletions };
}

export function syntheticUntrackedHunks(content: string): DiffHunk[] {
  const rawLines = content.split(/\r?\n/);
  const lines: DiffLine[] = rawLines.map((text, idx) => ({
    type: "added" as const,
    content: text,
    oldLineNumber: null,
    newLineNumber: idx + 1,
  }));
  const count = rawLines.length;
  return [{ header: `@@ -0,0 +1,${count} @@`, lines }];
}
