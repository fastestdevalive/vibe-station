import { describe, expect, it } from "vitest";
import type { Mention } from "@/api/types";
import { parseSkillSegments } from "./skillInvocation";
import {
  fromWire,
  isLeftBoundary,
  isRightBoundary,
  isSafeInlineId,
  mentionPlainText,
  mentionWireText,
  parseDraftSegments,
  quotePlain,
  renderDraftText,
  sanitizeMentionLabel,
  serializeDraftSegments,
  serializeMentionToken,
  toPlainText,
  toWire,
} from "./mentions";

const SKILL_VECTORS: string[] = [
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
  "{/no-close still typing",
  "C:\\Users\\me",
];

describe("mentions.ts — 1.T7 unit tests", () => {
  it("sanitizeMentionLabel replaces control characters and caps at 80", () => {
    expect(sanitizeMentionLabel("a\nb")).toBe("a b");
    expect(sanitizeMentionLabel("  trim me  ")).toBe("trim me");
    expect(sanitizeMentionLabel("x".repeat(100))).toHaveLength(80);
  });

  it("mentionPlainText bare and quoted", () => {
    expect(quotePlain("simple")).toBe("simple");
    expect(quotePlain("with space")).toBe('"with space"');
    expect(quotePlain('with"quote')).toBe('"with\\"quote"');
    expect(quotePlain("with\\slash")).toBe('"with\\\\slash"');

    const fileBare: Mention = { kind: "file", id: "src/a.ts", label: "a.ts" };
    expect(mentionPlainText(fileBare)).toBe("@src/a.ts");

    const fileQuoted: Mention = { kind: "file", id: "my dir/a b.ts", label: "a b.ts" };
    expect(mentionPlainText(fileQuoted)).toBe('@"my dir/a b.ts"');

    const agent: Mention = { kind: "agent", id: "s1", label: "Fix login" };
    expect(mentionPlainText(agent)).toBe('@agent:"Fix login"');

    const agentBare: Mention = { kind: "agent", id: "s1", label: "Fix" };
    expect(mentionPlainText(agentBare)).toBe("@agent:Fix");

    const worktree: Mention = { kind: "worktree", id: "wt1", label: "feat-x" };
    expect(mentionPlainText(worktree)).toBe("@worktree:feat-x");

    const project: Mention = { kind: "project", id: "p1", label: "my-proj" };
    expect(mentionPlainText(project)).toBe("@project:my-proj");
  });

  it("parseDraftSegments deep-equals parseSkillSegments for every skill vector", () => {
    for (const v of SKILL_VECTORS) {
      expect(parseDraftSegments(v)).toEqual(parseSkillSegments(v));
    }
  });

  it("parseDraftSegments and serializeDraftSegments fixpoint for complex tokens and text", () => {
    const complexDraft =
      'a \\{ literal {/skill arg with \\}} {@file ["path/with}and\\"and\\\\and|","b.ts"]} more text';
    const parsed = parseDraftSegments(complexDraft);
    const serialized = serializeDraftSegments(parsed);
    const parsedAgain = parseDraftSegments(serialized);
    expect(parsedAgain).toEqual(parsed);
  });

  it("malformed {@file [1]} stays literal", () => {
    const malformed = "{@file [1]}";
    const segs = parseDraftSegments(malformed);
    expect(segs).toEqual([{ type: "text", text: "{@file [1]}" }]);
  });

  it("toWire formats mentions and preserves order", () => {
    const draft = 'see {@file ["src/a.ts","a.ts"]} and {@agent ["s1","Fix login"]}';
    const wire = toWire(draft);
    expect(wire.text).toBe('see @src/a.ts and @agent:"Fix login" (id=s1)');
    expect(wire.mentions).toEqual([
      { kind: "file", id: "src/a.ts", label: "a.ts" },
      { kind: "agent", id: "s1", label: "Fix login" },
    ]);
  });

  it("padding a{@file…}b -> a @x b, but respects boundaries", () => {
    const draft1 = 'a{@file ["src/a.ts","a.ts"]}b';
    expect(toWire(draft1).text).toBe("a @src/a.ts b");

    // No space before comma
    const draftComma = 'see {@file ["src/a.ts","a.ts"]}, thanks';
    expect(toWire(draftComma).text).toBe("see @src/a.ts, thanks");

    // No space before period at end
    const draftPeriod = 'see {@file ["src/a.ts","a.ts"]}.';
    expect(toWire(draftPeriod).text).toBe("see @src/a.ts.");

    // No space after open paren
    const draftParen = '({@file ["src/a.ts","a.ts"]})';
    expect(toWire(draftParen).text).toBe("(@src/a.ts)");
  });

  it("fromWire(toWire(d).text, toWire(d).mentions) equals d for space-delimited drafts", () => {
    const d = 'see {@file ["src/a.ts","a.ts"]} and {@agent ["s1","Fix login"]} end';
    const wire = toWire(d);
    const restored = fromWire(wire.text, wire.mentions);
    expect(restored).toBe(d);
  });

  it("(a) path containing backslash or brace round-trips via toWire and fromWire", () => {
    const mention: Mention = {
      kind: "file",
      id: "src/dir\\a{b}.ts",
      label: "a{b}.ts",
    };
    const d = `check ${serializeMentionToken(mention)} now`;
    const wire = toWire(d);
    // Wire text contains escaped braces/backslashes
    expect(wire.text).toContain("\\{");
    const restored = fromWire(wire.text, wire.mentions);
    expect(restored).toBe(d);
  });

  it("(b) skill token next to real mention is NOT hydrated inside skill args", () => {
    const d = '{/review @src/a.ts} {@file ["src/a.ts","a.ts"]}';
    const wire = toWire(d);
    expect(wire.mentions).toHaveLength(1);
    const restored = fromWire(wire.text, wire.mentions);
    expect(restored).toBe(d);
  });

  it("user-typed literal \\{@x stays untouched", () => {
    const input = "a \\{@file not a token";
    const segs = parseDraftSegments(input);
    expect(segs).toEqual([{ type: "text", text: "a {@file not a token" }]);
  });

  it("unmatched mention is dropped and fromWire returns wire unchanged for empty/undefined mentions", () => {
    const wire = "see something";
    expect(fromWire(wire, undefined)).toBe(wire);
    expect(fromWire(wire, [])).toBe(wire);

    const missingMention: Mention = { kind: "file", id: "missing.ts", label: "missing.ts" };
    expect(fromWire(wire, [missingMention])).toBe(wire);
  });

  it("toPlainText writes id suffix for non-file and consumes it in fromWire", () => {
    const d = 'ask {@agent ["s1","Fix login"]} and see {@file ["src/a.ts","a.ts"]}';
    const wire = toWire(d);
    const plain = toPlainText(d);
    expect(plain).toBe('ask @agent:"Fix login" (id=s1) and see @src/a.ts');

    const restoredFromPlain = fromWire(plain, wire.mentions);
    expect(restoredFromPlain).toBe(d);
  });

  it("toWire of 60-chip draft caps mentions at 50 but keeps all in text", () => {
    const chips: string[] = [];
    for (let i = 0; i < 60; i++) {
      chips.push(`{@file ["f${i}.ts","f${i}.ts"]}`);
    }
    const draft = chips.join(" ");
    const wire = toWire(draft);
    expect(wire.mentions).toHaveLength(50);
    for (let i = 0; i < 60; i++) {
      expect(wire.text).toContain(`@f${i}.ts`);
    }
  });

  it("renderDraftText unescapes tokens to /name args and mentions to plain text", () => {
    const raw =
      'Use {/simplify high} on {@file ["src/a.ts","a.ts"]} and {@agent ["s1","Fix login"]} please.';
    expect(renderDraftText(raw)).toBe(
      'Use /simplify high on @src/a.ts and @agent:"Fix login" please.'
    );
  });

  it("isLeftBoundary and isRightBoundary detect whitespace and punctuation boundaries", () => {
    expect(isLeftBoundary("")).toBe(true);
    expect(isLeftBoundary("hello ")).toBe(true);
    expect(isLeftBoundary("hello(")).toBe(true);
    expect(isLeftBoundary("helloa")).toBe(false);

    expect(isRightBoundary("", 0)).toBe(true);
    expect(isRightBoundary(" hello", 0)).toBe(true);
    expect(isRightBoundary(",hello", 0)).toBe(true);
    expect(isRightBoundary(". hello", 0)).toBe(true);
    expect(isRightBoundary("ahello", 0)).toBe(false);
  });

  describe("inline ids", () => {
    const tok = (m: Mention) => serializeMentionToken(m);
    const a = (id: string, label: string): Mention => ({ kind: "agent", id, label });
    const roundTrip = (d: string) => {
      const w = toWire(d);
      return { w, back: fromWire(w.text, w.mentions) };
    };

    it("toWire and toPlainText share one serializer; files stay @path", () => {
      const d = `x ${tok(a("napi-1-a2", "Agent 2"))} y ${tok({ kind: "file", id: "a/b.ts", label: "b.ts" })}`;
      expect(toWire(d).text).toBe('x @agent:"Agent 2" (id=napi-1-a2) y @a/b.ts');
      expect(toPlainText(d)).toBe(toWire(d).text);
      expect(mentionWireText(a("s1", "Fix"))).toBe("@agent:Fix (id=s1)");
    });

    it("isSafeInlineId accepts plain ids and rejects ), space, quote, newline, unicode, long", () => {
      for (const ok of ["napi-1-a2", "3f2a", "a.b_c:d/e-f"]) expect(isSafeInlineId(ok)).toBe(true);
      for (const bad of ["a)b", "a b", 'a"b', "a\nb", "ünï", "", "x".repeat(129), "a(b"]) {
        expect(isSafeInlineId(bad)).toBe(false);
      }
    });

    it("unsafe ids are omitted from the text but stay in the sidecar and round-trip by label", () => {
      for (const id of ["a)b", "a b", 'a"b', "a\nb", "idé"]) {
        const d = `see ${tok(a(id, "Fix"))} now`;
        const { w, back } = roundTrip(d);
        expect(w.text).toBe("see @agent:Fix now");
        expect(w.mentions).toEqual([a(id, "Fix")]);
        expect(back).toBe(d);
      }
    });

    it("two mentions with the same label but different ids pair by id (order-independent)", () => {
      const d = `${tok(a("id-1", "main"))} and ${tok(a("id-2", "main"))}`;
      const w = toWire(d);
      expect(w.text).toBe("@agent:main (id=id-1) and @agent:main (id=id-2)");
      expect(fromWire(w.text, w.mentions)).toBe(d);
      // sidecar in reverse order still binds each span to its own id
      expect(fromWire(w.text, [...w.mentions].reverse())).toBe(d);
    });

    it("the same mention twice round-trips", () => {
      const d = `${tok(a("id-1", "main"))}, then ${tok(a("id-1", "main"))}.`;
      const { back } = roundTrip(d);
      expect(back).toBe(d);
    });

    it("renamed label: the id wins over the text", () => {
      const text = '@agent:"Old name" (id=id-9) please';
      const out = fromWire(text, [a("id-9", "New name")]);
      expect(out).toBe(`${tok(a("id-9", "New name"))} please`);
    });

    it("suffix whose id is not in the sidecar becomes a chip; text is never dropped", () => {
      const out = fromWire("hi @agent:Bob (id=zz9) and @src/a.ts", [
        { kind: "file", id: "src/a.ts", label: "a.ts" },
      ]);
      expect(out).toBe(
        `hi ${tok(a("zz9", "Bob"))} and ${tok({ kind: "file", id: "src/a.ts", label: "a.ts" })}`,
      );
    });

    it("labels with quotes/backslashes and adjacent punctuation round-trip", () => {
      const d = `(${tok(a("q1", 'say "hi" \\o/'))}), ok ${tok({ kind: "worktree", id: "w1", label: "feat-x" })}.`;
      const { w, back } = roundTrip(d);
      expect(w.text).toContain("(id=q1)");
      expect(back).toBe(d);
    });

    it("skill-token args containing a literal mention span are never touched", () => {
      const d = `{/review @agent:"x" (id=y)} ${tok(a("y", "x"))}`;
      const w = toWire(d);
      expect(w.mentions).toHaveLength(1);
      expect(fromWire(w.text, w.mentions)).toBe(d);
      // and orphan detection does not fire inside skill args
      const lone = "{/review @agent:x (id=y)}";
      expect(fromWire(lone, [a("other", "z")])).toBe(lone);
    });

    it("old messages without a suffix still hydrate by label", () => {
      const out = fromWire('see @agent:"Fix login" now', [a("s1", "Fix login")]);
      expect(out).toBe(`see ${tok(a("s1", "Fix login"))} now`);
    });

    it("label-only fallback does not steal a span that carries another id", () => {
      // sidecar entry id-2 has no suffix in text (unsafe id), span belongs to id-1 (orphan -> chip)
      const out = fromWire("@agent:main (id=id-1) @agent:main", [a("id 2", "main")]);
      expect(out).toBe(`${tok(a("id-1", "main"))} ${tok(a("id 2", "main"))}`);
    });
  });
});
