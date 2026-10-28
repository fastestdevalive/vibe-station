import { describe, expect, it } from "vitest";
import { makeComment } from "./testFixtures";
import { requestFromComment } from "./draftComment";

describe("requestFromComment", () => {
  it("copies exactly the CreateCommentRequest keys, never server-computed fields", () => {
    const c = { ...makeComment({ id: "c1", lineStart: 3, lineEnd: 4 }), brandNewServerField: 1, blockBytes: 99, attachedTo: "session:s" };
    const req = requestFromComment(c, "hello", 7);
    expect(Object.keys(req).sort()).toEqual(
      ["id", "lineEnd", "lineStart", "occurrence", "path", "pathKind", "prefix", "quote", "restorePin", "suffix", "surface", "text"].sort(),
    );
    expect(req).toMatchObject({ id: "c1", text: "hello", restorePin: 7, lineStart: 3 });
  });
});
