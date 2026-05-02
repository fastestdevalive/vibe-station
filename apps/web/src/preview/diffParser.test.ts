import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, summarizeDiffLines } from "./diffParser";

const __dirname = dirname(fileURLToPath(import.meta.url));

function load(name: string) {
  return readFileSync(join(__dirname, "__fixtures__", name), "utf8");
}

describe("parseUnifiedDiff", () => {
  it("parses simple add fixture", () => {
    const hunks = parseUnifiedDiff(load("simple-add.diff"));
    expect(hunks.length).toBe(1);
    const added = hunks[0]?.lines.filter((l) => l.type === "added");
    expect(added?.length).toBe(1);
    expect(added?.[0]?.content).toBe("added");
    expect(added?.[0]?.newLineNumber).toBe(2);
  });

  it("parses simple delete fixture", () => {
    const hunks = parseUnifiedDiff(load("simple-delete.diff"));
    expect(hunks.length).toBe(1);
    const removed = hunks[0]?.lines.filter((l) => l.type === "removed");
    expect(removed?.length).toBe(1);
    expect(removed?.[0]?.oldLineNumber).toBe(2);
  });

  it("parses mixed hunks", () => {
    const hunks = parseUnifiedDiff(load("mixed.diff"));
    expect(hunks.length).toBe(1);
    expect(hunks[0]?.lines.length).toBeGreaterThan(3);
  });

  it("summarizeDiffLines counts additions and deletions", () => {
    const hunks = parseUnifiedDiff(load("mixed.diff"));
    expect(summarizeDiffLines(hunks)).toEqual({ additions: 2, deletions: 1 });
  });
});
