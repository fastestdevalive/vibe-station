import { describe, expect, it } from "vitest";
import { buildWorktreeActivityMap, sessionActivityAt, sortByActivity } from "./sessionActivity";

const s = (over: Record<string, unknown>) =>
  ({ worktreeId: "w1", archivedAt: null, createdAt: "2026-10-21T09:00:00Z", lastActivityAt: null, ...over }) as Parameters<
    typeof buildWorktreeActivityMap
  >[0][number];

describe("sessionActivity (4.T1)", () => {
  it("falls back to createdAt when lastActivityAt is missing", () => {
    expect(sessionActivityAt({ createdAt: "2026-10-21T09:00:00Z", lastActivityAt: null })).toBe("2026-10-21T09:00:00Z");
    expect(sessionActivityAt({ createdAt: "2026-10-21T09:00:00Z", lastActivityAt: "2026-10-21T10:00:00Z" })).toBe(
      "2026-10-21T10:00:00Z",
    );
  });

  it("worktree activity is the max over non-archived sessions", () => {
    const map = buildWorktreeActivityMap([
      s({ lastActivityAt: "2026-10-21T10:00:00Z" }),
      s({ lastActivityAt: "2026-10-21T11:00:00Z", archivedAt: "2026-10-21T11:30:00Z" }),
      s({ createdAt: "2026-10-21T09:30:00Z" }),
      s({ worktreeId: "w2", createdAt: "2026-10-20T00:00:00Z" }),
      s({ worktreeId: null }),
    ]);
    expect(map.get("w1")).toBe("2026-10-21T10:00:00Z");
    expect(map.get("w2")).toBe("2026-10-20T00:00:00Z");
    expect(map.size).toBe(2);
  });

  it("sortByActivity: newest first, ties keep input order, nulls last, input untouched", () => {
    const items = [
      { id: "a", at: "2026-10-21T10:00:00Z" },
      { id: "b", at: null },
      { id: "c", at: "2026-10-21T11:00:00Z" },
      { id: "d", at: "2026-10-21T10:00:00Z" },
      { id: "e", at: "garbage" },
    ];
    const copy = [...items];
    expect(sortByActivity(items, (i) => i.at).map((i) => i.id)).toEqual(["c", "a", "d", "b", "e"]);
    expect(items).toEqual(copy);
  });
});
