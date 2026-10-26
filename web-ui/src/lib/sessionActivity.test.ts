import { describe, expect, it } from "vitest";
import { buildWorktreeActivityMap, sessionActivityAt, sortByActivity, stableActivityOrder } from "./sessionActivity";

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

describe("stableActivityOrder", () => {
  const min = 60_000;
  const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + m * min).toISOString();
  const mk = (id: string, m: number) => ({ id, at: t(m) });
  const run = (items: { id: string; at: string }[], prev: string[]) =>
    stableActivityOrder(items, (i) => i.id, (i) => i.at, prev).map((i) => i.id);

  it("sorts newest first when there is no previous order", () => {
    expect(run([mk("a", 0), mk("b", 10), mk("c", 5)], [])).toEqual(["b", "c", "a"]);
  });

  it("keeps order when activity differs by <= 3 minutes", () => {
    expect(run([mk("a", 10), mk("b", 12), mk("c", 13)], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(run([mk("a", 10), mk("b", 13)], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("moves an item up once it is more than 3 minutes newer", () => {
    expect(run([mk("a", 10), mk("b", 14)], ["a", "b"])).toEqual(["b", "a"]);
  });

  it("drops vanished ids and places new ones by activity", () => {
    expect(run([mk("a", 10), mk("n", 30)], ["gone", "a"])).toEqual(["n", "a"]);
  });

  it("a chain of small gaps cannot strand a much newer item at the bottom", () => {
    expect(run([mk("x", 0), mk("y", 2.9), mk("z", 5.8)], ["x", "y", "z"])).toEqual(["z", "x", "y"]);
  });
});
