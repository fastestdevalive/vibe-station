import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReviewText } from "./parseReviewText";

// vitest runs from web-ui/; the Rust goldens are the spec of the format.
const dir = `${resolve(process.cwd(), "../rust/vst-types/tests/fixtures/review")}/`;
const read = (n: string) => readFileSync(`${dir}${n}.txt`, "utf8");

describe("parseReviewText (4.T4)", () => {
  it("parses every Rust golden fixture", () => {
    const names = readdirSync(dir).filter((f) => f.endsWith(".txt"));
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const f of names) {
      const parsed = parseReviewText(readFileSync(`${dir}${f}`, "utf8"));
      expect(parsed, f).not.toBeNull();
      expect(parsed!.record.comments.length, f).toBeGreaterThan(0);
    }
  });

  it("multi-line diff fixture: ranges, side, scope, bodies and escaped quotes", () => {
    const p = parseReviewText(read("multiline-diff"))!;
    expect(p.record.name).toBe("main");
    const [a, b] = p.record.comments;
    expect(a).toMatchObject({ pin: 1, path: "src/lib.rs", side: "old", diffScope: "branch", lines: { start: 10, end: 12 }, quote: "fn a() {\n    1\n}", text: "split this:\n\n- first\n- second" });
    expect(b).toMatchObject({ pin: 2, side: "new", diffScope: "local", lines: { start: 30, end: 30 }, quote: 'let s = "hi";', text: 'quotes "ok"' });
  });

  it("outdated and missing suffixes, absolute paths, quote-only items, pin gaps", () => {
    const o = parseReviewText(read("outdated-missing"))!.record.comments;
    expect(o[0]).toMatchObject({ path: "src/a.rs", anchor: "outdated" });
    expect(o[1]).toMatchObject({ path: "src/gone.rs", anchor: "file_missing" });
    expect(o[1]!.lines).toBeUndefined();
    expect(parseReviewText(read("absolute-path"))!.record.comments[0]).toMatchObject({ pathKind: "artifact", path: "/Users/me/.claude/plans/a-very-long-folder-name/another/plan.md" });
    expect(parseReviewText(read("quote-only"))!.record.comments[0]!.lines).toBeUndefined();
    expect(parseReviewText(read("pin-gaps"))!.record.comments.map((c) => c.pin)).toEqual([9, 3, 7]);
  });

  // Strings below are exactly what `render_review_block` (review_format.rs) emits: the header drops
  // ` · name` for an empty name, and `item` skips the Quote line for an empty quote.
  it("nameless header (empty scope name) parses", () => {
    const text = 'Review comments (1)\n\n1) File: src/a.rs\n   Quote: "x"\n   Comment: y';
    const p = parseReviewText(text)!;
    expect(p.record.name).toBe("");
    expect(p.record.comments[0]).toMatchObject({ path: "src/a.rs", quote: "x", text: "y" });
  });

  it("empty-quote item (blank-line gutter comment) parses with quote ''", () => {
    const text = "Review comments (1) · main\n\n1) File: src/a.rs\n   Lines: 4\n   Comment: blank line";
    const p = parseReviewText(text)!;
    expect(p.record.comments[0]).toMatchObject({ lines: { start: 4, end: 4 }, quote: "", text: "blank line" });
  });

  it("splits the user's own message off the front", () => {
    const p = parseReviewText(read("with-message"))!;
    expect(p.message).toBe("Please fix these.");
    expect(p.record.comments).toHaveLength(1);
  });

  it("unparsable text or a count mismatch is null (stays plain text)", () => {
    expect(parseReviewText("just a message")).toBeNull();
    expect(parseReviewText("Review comments (2) · main\n\n1) File: a.rs\n   Quote: \"x\"\n   Comment: y")).toBeNull();
    expect(parseReviewText("Review comments (1) · main\n\n1) File: a.rs\n   garbage")).toBeNull();
  });
});
