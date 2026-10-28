import { describe, expect, it } from "vitest";
import { renderDraftText, serializeMentionToken } from "@/lib/mentions";
import { toDraft } from "./CommentBox";
import { truncateUtf8, checkSendLimit, blockBytes } from "./reviewLimits";

describe("comment text seam (4.T9)", () => {
  it("braces and backslashes round-trip unescaped through the draft grammar (renderDraftText, not toWire)", () => {
    const code = "a{b}\\c and {/not-a-skill} {@file x}";
    expect(renderDraftText(toDraft(code))).toBe(code);
  });

  it("an @file chip renders as @path, files stay plain", () => {
    const token = serializeMentionToken({ kind: "file", id: "src/a.ts", label: "a.ts" });
    expect(renderDraftText(`see ${token} now`)).toBe("see @src/a.ts now");
  });
});

describe("review limits", () => {
  it("truncateUtf8 keeps whole code points", () => {
    expect(truncateUtf8("ab😀", 4)).toBe("ab");
    expect(truncateUtf8("abc", 10)).toBe("abc");
  });
  it("send limits: 200 comments / 128 KB for Rich Chat, 32 KB for Terminal; Copy is never limited", () => {
    const many = Array.from({ length: 201 }, () => ({ blockBytes: 10 }));
    expect(checkSendLimit(many, "rich")).toMatchObject({ over: true, unit: "comments", excess: 1 });
    const big = [{ blockBytes: 40_000 }];
    expect(checkSendLimit(big, "rich").over).toBe(false);
    expect(checkSendLimit(big, "terminal")).toMatchObject({ over: true, unit: "bytes" });
    expect(blockBytes([], "x")).toBe(0);
  });
});
