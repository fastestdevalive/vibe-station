import { describe, expect, it } from "vitest";
import { parseReviewText } from "@/components/comments/parseReviewText";
import { createMockComments } from "./mockComments";
import type { CreateCommentRequest } from "./types";

const req = (over: Partial<CreateCommentRequest> & { id: string }): CreateCommentRequest => ({
  path: "src/a.rs",
  pathKind: "repo",
  surface: "file",
  quote: "fn main()",
  prefix: "",
  suffix: "",
  occurrence: 1,
  text: "rename",
  ...over,
});

describe("mock renderComments", () => {
  it("renders the daemon's Appendix A format: parseReviewText reads the same count back", async () => {
    const mock = createMockComments(() => {}, () => "main");
    await mock.createComment("wt", "worktree", req({ id: "a", lineStart: 3, lineEnd: 5, text: "two\nlines" }));
    await mock.createComment("wt", "worktree", req({ id: "b", quote: "", lineStart: 9, text: "blank line" }));
    const { text, count } = await mock.renderComments("wt", "worktree", { message: "hello" });
    const parsed = parseReviewText(text)!;
    expect(parsed.message).toBe("hello");
    expect(parsed.record.comments).toHaveLength(count);
    expect(parsed.record.comments[0]).toMatchObject({ lines: { start: 3, end: 5 }, text: "two\nlines", quote: "fn main()" });
    expect(parsed.record.comments[1]).toMatchObject({ quote: "", text: "blank line" });
  });
});
