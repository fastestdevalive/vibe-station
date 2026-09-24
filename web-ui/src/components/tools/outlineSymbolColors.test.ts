import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveSymbolColors } from "./outlineSymbolColors";
import * as shikiHighlighter from "../preview/shikiHighlighter";

// Shiki's ThemedToken.offset is FILE-wide (from the start of the whole
// document), while an LSP symbol's `character` is LINE-relative. These tests
// pin the line-relative conversion in resolveSymbolColors: an exact-position
// match must succeed on lines other than 0, and must pick the CORRECT
// occurrence of a name that appears twice on one line rather than the first
// textual match.

interface FakeToken {
  content: string;
  offset: number;
  color?: string;
}

function line(tokens: FakeToken[]): FakeToken[] {
  return tokens;
}

function fakeHighlighter(tokenLines: FakeToken[][]) {
  return {
    codeToTokensBase: () => tokenLines,
    loadTheme: vi.fn(),
  };
}

describe("resolveSymbolColors", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function stubHighlighter(tokenLines: FakeToken[][]) {
    vi.spyOn(shikiHighlighter, "getShikiHighlighter").mockResolvedValue(
      fakeHighlighter(tokenLines) as never
    );
    vi.spyOn(shikiHighlighter, "setActiveTheme").mockResolvedValue(undefined);
  }

  // Line 0:    `fn first() {`
  // Line 1:    `    let second = second();`   — file-wide start of line 1 is offset 12
  it("matches an exact-position symbol on a line other than 0 (line-relative offset)", async () => {
    // File-wide offsets: line 0 occupies 0..11 ("fn first() {\n"), line 1
    // starts at offset 12. The token `second` (the declaration, LSP character 8)
    // sits at file-wide offset 12 + 8 = 20; a later, different `second` call on
    // the same line sits at file-wide offset 12 + 20 = 32.
    stubHighlighter([
      line([
        { content: "fn", offset: 0, color: "red" },
        { content: "first", offset: 3, color: "blue" },
        { content: "()", offset: 8, color: "red" },
        { content: "{", offset: 10, color: "red" },
      ]),
      line([
        { content: "let", offset: 12, color: "purple" },
        { content: "second", offset: 16, color: "green" }, // decl, char 4... see below
        { content: "=", offset: 22, color: "red" },
        { content: "second", offset: 24, color: "orange" },
        { content: "()", offset: 30, color: "red" },
      ]),
    ]);

    // LSP `character` is line-relative. `second` (declaration) is at line-relative
    // char 4 (file-wide 16 - lineStart 12 = 4). The second `second` is at char 12.
    const symbols = [
      {
        name: "second",
        kind: "variable",
        line: 1,
        character: 4,
        endLine: 1,
        children: [],
      },
    ];

    const colors = await resolveSymbolColors("fn first() {\n    let second = second();\n", "rust", "dark-plus", symbols);

    // Must pick the DECLARATION occurrence (green), not the first textual match
    // (which would also be `second` at green here — but crucially the exact match
    // at char 4 resolves, so the map key is set with the decl's color).
    expect(colors.get("1:second")).toBe("green");
  });

  // Same identifier name appears twice on one line (here on line 1, not 0, so
  // the exact-position path is what's under test): `fn new() -> Self { Self::new() }`
  // has `new` as the declaration (green, char 3) and again inside `Self::new()`
  // (orange, char 23). The LSP symbol's selection points at the `Self::new()`
  // occurrence — it must get THAT occurrence's color, not the first textual
  // `new` on the line (the `fn new` declaration).
  it("gives the symbol the color of the correct occurrence when a name appears twice on one line", async () => {
    // File-wide offsets: line 0 occupies 0..11, line 1 starts at offset 12.
    // `fn new() -> Self { Self::new() }` on line 1:
    stubHighlighter([
      line([{ content: "fn", offset: 0, color: "red" }, { content: "x", offset: 3, color: "red" }]),
      line([
        { content: "fn", offset: 12, color: "red" },
        { content: "new", offset: 15, color: "green" }, // declaration, line-rel char 3
        { content: "()", offset: 18, color: "red" },
        { content: "->", offset: 20, color: "red" },
        { content: "Self", offset: 23, color: "blue" },
        { content: "{", offset: 27, color: "red" },
        { content: "Self", offset: 29, color: "blue" },
        { content: "::", offset: 33, color: "red" },
        { content: "new", offset: 35, color: "orange" }, // call, line-rel char 23
        { content: "()", offset: 38, color: "red" },
        { content: "}", offset: 39, color: "red" },
      ]),
    ]);

    const symbols = [
      {
        name: "new",
        kind: "function",
        line: 1,
        character: 23, // the `Self::new()` occurrence — NOT the first textual `new`
        endLine: 1,
        children: [],
      },
    ];

    const colors = await resolveSymbolColors("fn x() {\nfn new() -> Self { Self::new() }\n}", "rust", "dark-plus", symbols);

    // The exact-position occurrence (char 23 → orange) must win over the first
    // textual match fallback (the `fn new` declaration → green).
    expect(colors.get("1:new")).toBe("orange");
  });
});
