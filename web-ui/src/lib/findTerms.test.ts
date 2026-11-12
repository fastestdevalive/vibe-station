import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { findTerms, fold, locate, eventFindText, countLocal } from "./findTerms";
import type { NormalizedEvent } from "@/api/types";

interface TestCase {
  q: string;
  terms: string[];
  text: string;
  ranges: Array<[number, number]>;
}

describe("findTerms", () => {
  it("splits words and drops <3 scalar words", () => {
    expect(findTerms("an apple")).toEqual(["apple"]);
    expect(findTerms("hello world")).toEqual(["hello", "world"]);
  });

  it("falls back to trimmed phrase when terms are empty and length >= 3", () => {
    expect(findTerms("to be")).toEqual(["to be"]);
    expect(findTerms("a b")).toEqual(["a b"]);
  });

  it("returns empty array for invalid empty or >200 scalar queries", () => {
    expect(findTerms("   ")).toEqual([]);
    expect(findTerms("a".repeat(201))).toEqual([]);
  });

  it("de-duplicates terms after folding", () => {
    expect(findTerms("cafe CAFÉ")).toEqual(["cafe"]);
  });

  it("folds diacritics and case correctly", () => {
    expect(fold("café").folded).toBe("cafe");
    expect(fold("Résumé").folded).toBe("resume");
    expect(fold("İstanbul").folded).toBe("istanbul");
    expect(fold("straße").folded).toBe("straße");
    expect(fold("ЧАЙНЫЙ").folded).toBe("чайный");
  });

  it("locates terms and merges overlapping/adjacent matches", () => {
    expect(locate("look at abcd", ["abc", "bcd"])).toEqual([[8, 12]]);
    expect(locate("this is foobar", ["foo", "bar"])).toEqual([[8, 14]]);
  });

  it("returns empty when document does not contain all terms", () => {
    expect(locate("hello beautiful place", ["hello", "world"])).toEqual([]);
  });

  it("correctly handles emoji offsets (UTF-16)", () => {
    expect(locate("😀hello", ["hello"])).toEqual([[2, 7]]);
  });

  it("verifies fixture cases from disk", () => {
    const fixturePath = path.resolve(
      __dirname,
      "../../../rust/vst-store/tests/fixtures/transcript_search_cases.json",
    );
    const content = fs.readFileSync(fixturePath, "utf-8");
    const cases = JSON.parse(content) as TestCase[];

    for (const c of cases) {
      const terms = findTerms(c.q);
      expect(terms).toEqual(c.terms);
      const ranges = locate(c.text, terms);
      expect(ranges).toEqual(c.ranges);
    }
  });

  it("eventFindText and countLocal work across scopes", () => {
    const events: NormalizedEvent[] = [
      {
        sessionId: "s1",
        id: "1",
        kind: "user",
        text: "hello world",
        ts: "2026-01-01T00:00:00Z",
        provider: "claude",
      },
      {
        sessionId: "s1",
        id: "2",
        kind: "text",
        text: "hello from assistant",
        ts: "2026-01-01T00:00:01Z",
        provider: "claude",
        turnId: "t1",
      },
      {
        sessionId: "s1",
        id: "3",
        kind: "tool_use",
        toolName: "bash",
        toolInput: { cmd: "echo hello" },
        ts: "2026-01-01T00:00:02Z",
        provider: "claude",
      },
      {
        sessionId: "s1",
        id: "4",
        kind: "user",
        silent: true,
        text: "hello silent",
        ts: "2026-01-01T00:00:03Z",
        provider: "claude",
      },
    ];

    expect(countLocal(events, ["hello"], "messages")).toBe(2);
    expect(countLocal(events, ["hello"], "all")).toBe(3);
  });

  it("eventFindText extracts text from user, assistant, thinking, tool, and error events", () => {
    expect(eventFindText({ kind: "user", text: "hi" } as NormalizedEvent)).toEqual({
      kind: "user",
      text: "hi",
    });
    expect(eventFindText({ kind: "text", text: "hello" } as NormalizedEvent)).toEqual({
      kind: "text",
      text: "hello",
    });
    expect(eventFindText({ kind: "thinking", text: "thought" } as NormalizedEvent)).toEqual({
      kind: "thinking",
      text: "thought",
    });
    const toolEvent = eventFindText({
      kind: "tool_use",
      toolName: "Read",
      toolInput: { path: "a.ts" },
    } as NormalizedEvent);
    expect(toolEvent?.kind).toBe("tool_use");
    expect(toolEvent?.text).toContain("Read");
    expect(toolEvent?.text).toContain("a.ts");

    expect(
      eventFindText({
        kind: "tool_result",
        toolResult: { content: "file content" },
      } as NormalizedEvent),
    ).toEqual({
      kind: "tool_result",
      text: "file content",
    });

    // Per boundary contract: superseded rows, silent user rows, and all other kinds never match
    expect(eventFindText({ kind: "error", text: "oops" } as NormalizedEvent)).toBeNull();
    expect(eventFindText({ kind: "user", text: "silent", silent: true } as NormalizedEvent)).toBeNull();
    expect(eventFindText({ kind: "text", text: "old", superseded: true } as NormalizedEvent)).toBeNull();
  });
});
