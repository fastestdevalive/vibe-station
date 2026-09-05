/**
 * skill-invocation-in-chat REPLAN Phase 7A.1 — tokenizer/serializer/escaper
 * round-trip suite for the `{/name args}` grammar (D2/D3).
 *
 * This EXACT test-vector table is shared with web-ui's independent
 * implementation (`skillInvocation.ts`, Phase 7B.2) — see the plan's Phase 7
 * Risk #1. Any change to escaping or tokenization must be validated against
 * both.
 */
import { describe, it, expect } from "vitest";
import { parseSkillSegments, serializeSkillSegments, type SkillSegment } from "../services/skillTokens.js";

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

describe("7A.1 — round-trip: parse(serialize(parse(x))) is a fixpoint", () => {
  for (const [i, x] of VECTORS.entries()) {
    it(`vector ${i + 1}: ${JSON.stringify(x)}`, () => {
      const once = parseSkillSegments(x);
      const twice = parseSkillSegments(serializeSkillSegments(once));
      expect(twice).toEqual(once);
    });
  }
});

describe("7A.1 — per-vector shape assertions", () => {
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

describe("7A.1 — additional escaping/edge cases", () => {
  it("unterminated token degrades to literal text", () => {
    const segs = parseSkillSegments("{/no-close still typing");
    expect(segs).toEqual([{ type: "text", text: "{/no-close still typing" }]);
  });

  it("a lone backslash not followed by an escape target is preserved literally", () => {
    const segs = parseSkillSegments("C:\\Users\\name");
    expect(segs).toEqual([{ type: "text", text: "C:\\Users\\name" }]);
  });

  it("serializing round-trips a token with a literal '}' and '{' in args", () => {
    const segs: SkillSegment[] = [{ type: "token", name: "x", args: "a{b}c" }];
    const s = serializeSkillSegments(segs);
    expect(parseSkillSegments(s)).toEqual(segs);
  });

  it("empty input → no segments", () => {
    expect(parseSkillSegments("")).toEqual([]);
  });
});
