import type { ReviewComment, TerminalDelivery } from "@/api/types";

export function makeComment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    scopeKind: "worktree",
    scopeId: "wt-1",
    pin: 1,
    path: "src/App.tsx",
    pathKind: "repo",
    surface: "file",
    quote: "quote",
    prefix: "",
    suffix: "",
    occurrence: 0,
    text: "comment text",
    anchor: "anchored",
    lineStart: 1,
    lineEnd: 1,
    blockBytes: 100,
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

export function makeDelivery(over: Partial<TerminalDelivery> = {}): TerminalDelivery {
  return {
    id: "d1",
    scopeKind: "worktree",
    scopeId: "wt-1",
    sessionId: "s1",
    state: "waiting",
    commentIds: ["c1"],
    commentCount: 1,
    bytes: 100,
    updatedAt: "2026-01-01T00:00:01Z",
    ...over,
  };
}
