import { describe, expect, it } from "vitest";
import {
  escapeSkillArgs,
  escapeSkillText,
  filterCommands,
  migrateV1Draft,
  parseSkillSegments,
  renderSkillMessageText,
  serializeSkillSegments,
  type SkillSegment,
} from "./skillInvocation";

/**
 * This EXACT test-vector table is shared with the daemon's independent
 * implementation (`daemon/src/services/skillTokens.ts`,
 * `daemon/src/__tests__/skillTokens.test.ts`) — see the plan's Phase 7 Risk
 * #1. Any change to escaping or tokenization must be validated against both.
 */
const VECTORS: string[] = [
  "hello world",
  "{/code-review}",
  "{/code-review high --fix}",
  "Can you use {/code-review high --fix} to do this. Also use {/simplify}.",
  "a \\{ literal brace",
  "{/x args with \\} brace}",
  "back\\\\slash",
  "{/plugin:skill-name arg}",
  "{/apps/web:deploy arg}",
  "{/unknown-skill args}",
];

describe("7B.2 — round-trip: parse(serialize(parse(x))) is a fixpoint", () => {
  for (const [i, x] of VECTORS.entries()) {
    it(`vector ${i + 1}: ${JSON.stringify(x)}`, () => {
      const once = parseSkillSegments(x);
      const twice = parseSkillSegments(serializeSkillSegments(once));
      expect(twice).toEqual(once);
    });
  }
});

describe("7B.2 — per-vector shape assertions", () => {
  it("1. plain prose → 0 tokens", () => {
    const segs = parseSkillSegments("hello world");
    expect(segs.filter((s) => s.type === "token")).toHaveLength(0);
  });

  it("2. bare token → 1 token, name=code-review, args=''", () => {
    const segs = parseSkillSegments("{/code-review}");
    expect(segs).toEqual([{ type: "token", name: "code-review", args: "" }]);
  });

  it("3. token with args → args='high --fix'", () => {
    const segs = parseSkillSegments("{/code-review high --fix}");
    expect(segs).toEqual([{ type: "token", name: "code-review", args: "high --fix" }]);
  });

  it("4. two tokens mid-sentence → 2 tokens", () => {
    const segs = parseSkillSegments(
      "Can you use {/code-review high --fix} to do this. Also use {/simplify}.",
    );
    const tokens = segs.filter((s): s is Extract<SkillSegment, { type: "token" }> => s.type === "token");
    expect(tokens).toEqual([
      { type: "token", name: "code-review", args: "high --fix" },
      { type: "token", name: "simplify", args: "" },
    ]);
  });

  it("5. escaped brace in text → 0 tokens, text contains literal '{'", () => {
    const segs = parseSkillSegments("a \\{ literal brace");
    expect(segs).toEqual([{ type: "text", text: "a { literal brace" }]);
  });

  it("6. escaped '}' inside args → 1 token, args contains literal '}'", () => {
    const segs = parseSkillSegments("{/x args with \\} brace}");
    expect(segs).toEqual([{ type: "token", name: "x", args: "args with } brace" }]);
  });

  it("7. escaped backslash in text → text contains a literal '\\'", () => {
    const segs = parseSkillSegments("back\\\\slash");
    expect(segs).toEqual([{ type: "text", text: "back\\slash" }]);
  });

  it("8. name containing ':' tokenizes", () => {
    const segs = parseSkillSegments("{/plugin:skill-name arg}");
    expect(segs).toEqual([{ type: "token", name: "plugin:skill-name", args: "arg" }]);
  });

  it("9. name containing '/' tokenizes", () => {
    const segs = parseSkillSegments("{/apps/web:deploy arg}");
    expect(segs).toEqual([{ type: "token", name: "apps/web:deploy", args: "arg" }]);
  });

  it("10. unknown skill name still tokenizes fine (resolution is the caller's job)", () => {
    const segs = parseSkillSegments("{/unknown-skill args}");
    expect(segs).toEqual([{ type: "token", name: "unknown-skill", args: "args" }]);
  });
});

describe("7B.2 — additional escaping/edge cases", () => {
  it("unterminated token degrades to literal text", () => {
    const segs = parseSkillSegments("{/no-close still typing");
    expect(segs).toEqual([{ type: "text", text: "{/no-close still typing" }]);
  });

  it("a lone backslash not followed by an escape target is preserved literally", () => {
    const segs = parseSkillSegments("C:\\Users\\me");
    expect(segs).toEqual([{ type: "text", text: "C:\\Users\\me" }]);
  });

  it("escapeSkillText escapes backslash and brace, not close-brace", () => {
    expect(escapeSkillText("a{b}\\c")).toBe("a\\{b}\\\\c");
  });

  it("escapeSkillArgs additionally escapes close-brace", () => {
    expect(escapeSkillArgs("a{b}\\c")).toBe("a\\{b\\}\\\\c");
  });
});

describe("filterCommands", () => {
  const commands = [
    { name: "code-review", description: "Review" },
    { name: "simplify", description: "Simplify" },
  ] as never;

  it("empty query returns all", () => {
    expect(filterCommands(commands, "")).toHaveLength(2);
  });

  it("substring, case-insensitive filter", () => {
    expect(filterCommands(commands, "REV")).toHaveLength(1);
  });
});

describe("renderSkillMessageText (7B.10 — display unescaping)", () => {
  it("tokens render as /name args, no braces", () => {
    expect(renderSkillMessageText("Can you use {/code-review high --fix} to do this.")).toBe(
      "Can you use /code-review high --fix to do this.",
    );
  });

  it("a bare token with no args renders as /name only", () => {
    expect(renderSkillMessageText("{/simplify}.")).toBe("/simplify.");
  });

  it("escaped braces in prose are unescaped for display", () => {
    expect(renderSkillMessageText("a \\{ literal brace")).toBe("a { literal brace");
  });

  it("multiple tokens mid-sentence all unescape", () => {
    expect(
      renderSkillMessageText("Can you use {/code-review high --fix} to do this. Also use {/simplify}."),
    ).toBe("Can you use /code-review high --fix to do this. Also use /simplify.");
  });
});

describe("migrateV1Draft (7B.7 — one-shot v1 draft migration)", () => {
  const CATALOG = ["code-review", "simplify"];

  it("v1 canonical string with args + prose migrates to a leading token", () => {
    expect(migrateV1Draft("/code-review high --fix\nplease do this", CATALOG)).toBe(
      "{/code-review high --fix}please do this",
    );
  });

  it("v1 canonical string with no args migrates", () => {
    expect(migrateV1Draft("/simplify\nclean it up", CATALOG)).toBe("{/simplify}clean it up");
  });

  it("v1 canonical string with no prose migrates to a bare token", () => {
    expect(migrateV1Draft("/simplify", CATALOG)).toBe("{/simplify}");
  });

  it("already-migrated (brace tokens present) is left unchanged", () => {
    const v2 = "{/code-review high --fix} please do this";
    expect(migrateV1Draft(v2, CATALOG)).toBe(v2);
  });

  it("plain prose (no leading slash) is left unchanged", () => {
    expect(migrateV1Draft("hello world", CATALOG)).toBe("hello world");
  });

  it("leading slash not matching any catalog name is left unchanged", () => {
    expect(migrateV1Draft("/unknown-thing\nhi", CATALOG)).toBe("/unknown-thing\nhi");
  });

  it("round-trips through parseSkillSegments afterward", () => {
    const migrated = migrateV1Draft("/code-review high --fix\nplease do this", CATALOG);
    const segs = parseSkillSegments(migrated);
    expect(segs).toEqual([
      { type: "token", name: "code-review", args: "high --fix" },
      { type: "text", text: "please do this" },
    ]);
  });
});
