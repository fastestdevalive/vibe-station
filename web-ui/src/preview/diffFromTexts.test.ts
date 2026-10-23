import { describe, expect, it } from "vitest";
import { countLines, diffLinesToHunks } from "./diffFromTexts";

describe("diffLinesToHunks — numbering", () => {
  it("numbers from the supplied oldStart/newStart instead of 1", () => {
    const oldText = "ctx a\nctx b\nbefore\nctx c\nctx d\n";
    const newText = "ctx a\nctx b\nafter\nctx c\nctx d\n";
    const hunk = diffLinesToHunks(oldText, newText, 38, 38)[0]!;

    expect(hunk.header).toBe("@@ -38,5 +38,5 @@");
    const numbers = hunk.lines.map((l) => [l.type, l.oldLineNumber, l.newLineNumber]);
    expect(numbers).toEqual([
      ["context", 38, 38],
      ["context", 39, 39],
      ["removed", 40, null],
      ["added", null, 40],
      ["context", 41, 41],
      ["context", 42, 42],
    ]);
  });

  it("keeps divergent old/new starts (an insertion shifted the new side)", () => {
    const hunk = diffLinesToHunks("same\n", "added\nsame\n", 37, 39)[0]!;
    expect(hunk.header).toBe("@@ -37,1 +39,2 @@");
    expect(hunk.lines[0]!).toMatchObject({ type: "added", oldLineNumber: null, newLineNumber: 39 });
    expect(hunk.lines[1]!).toMatchObject({ type: "context", oldLineNumber: 37, newLineNumber: 40 });
  });

  it("defaults to line 1 for a diff with no starts (untrimmed whole file)", () => {
    const hunk = diffLinesToHunks("a\nb\n", "a\nB\n")[0]!;
    expect(hunk.header).toBe("@@ -1,2 +1,2 @@");
    expect(hunk.lines[0]!.oldLineNumber).toBe(1);
  });

  it("numbers an empty old side (new file) from 0,0 on the old side", () => {
    const hunk = diffLinesToHunks("", "one\ntwo\n", 1, 1)[0]!;
    expect(hunk.header).toBe("@@ -0,0 +1,2 @@");
    expect(hunk.lines.every((l) => l.oldLineNumber === null)).toBe(true);
    expect(hunk.lines.map((l) => l.newLineNumber)).toEqual([1, 2]);
  });

  it("counts an EOF hunk with no trailing newline exactly", () => {
    const hunk = diffLinesToHunks("x\ntail", "x\nTAIL", 9, 9)[0]!;
    expect(hunk.header).toBe("@@ -9,2 +9,2 @@");
  });
});

describe("countLines", () => {
  it("counts \\n-terminated lines and a final unterminated line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one\n")).toBe(1);
    expect(countLines("one\ntwo")).toBe(2);
    expect(countLines("one\ntwo\n")).toBe(2);
  });

  it("does not treat a bare \\r as a line break (matches the renderer)", () => {
    expect(countLines("a\rb\n")).toBe(1);
  });
});
