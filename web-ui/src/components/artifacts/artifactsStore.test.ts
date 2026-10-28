import { beforeEach, describe, expect, it } from "vitest";
import { rowMatchesPath, rowsFor, useArtifactsStore } from "./artifactsStore";
import { makeRow, upsert } from "./testFixtures";

const S = "wt1";
const st = () => useArtifactsStore.getState();

function load(rev = 1, items = [makeRow({ id: "a", lastWrittenAt: "2026-10-27T10:00:00.000Z" })]) {
  st().replace(S, "worktree", { rev, cap: 500, total: items.length, items });
}

beforeEach(() => st().reset());

const byPath = (state: ReturnType<typeof useArtifactsStore.getState>, scope: string, p: string) =>
  rowsFor(state, scope).find((r) => rowMatchesPath(r, p));

describe("artifactsStore (6.T1)", () => {
  it("upsert replaces by id and keeps newest-first order", () => {
    load(1, [
      makeRow({ id: "a", lastWrittenAt: "2026-10-27T10:00:00.000Z" }),
      makeRow({ id: "b", lastWrittenAt: "2026-10-27T09:00:00.000Z" }),
    ]);
    st().applyUpserted({ scopeId: S, rev: 2, rows: [upsert({ id: "b", lastWrittenAt: "2026-10-27T11:00:00.000Z", editCount: 2 })] });
    const rows = rowsFor(st(), S);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[0]!.editCount).toBe(2);
    expect(rows).toHaveLength(2);
  });

  it("created rows are returned and counted toward the total", () => {
    load();
    const created = st().applyUpserted({ scopeId: S, rev: 2, rows: [upsert({ id: "n" }, true)] });
    expect(created.map((r) => r.id)).toEqual(["n"]);
    expect(st().byScope[S]!.total).toBe(2);
  });

  it("removed drops ids; cap lowers the total, user removal keeps it (hidden rows count)", () => {
    load(1, [makeRow({ id: "a" }), makeRow({ id: "b" }), makeRow({ id: "c" })]);
    st().applyRemoved({ scopeId: S, rev: 2, ids: ["a"], reason: "removed" });
    expect(rowsFor(st(), S).map((r) => r.id).sort()).toEqual(["b", "c"]);
    expect(st().byScope[S]!.total).toBe(3);
    st().applyRemoved({ scopeId: S, rev: 3, ids: ["b"], reason: "cap" });
    expect(st().byScope[S]!.total).toBe(2);
    expect(st().byScope[S]!.capNotice).toMatchObject({ count: 1 });
  });

  it("rev <= last is ignored (repeat and the list-response race): no change, no refetch flag", () => {
    load(5);
    const before = st().byScope[S];
    st().applyUpserted({ scopeId: S, rev: 5, rows: [upsert({ id: "zzz" }, true)] });
    st().applyUpserted({ scopeId: S, rev: 3, rows: [upsert({ id: "yyy" }, true)] });
    st().applyRemoved({ scopeId: S, rev: 4, ids: ["a"], reason: "removed" });
    expect(st().byScope[S]).toBe(before);
    expect(st().byScope[S]!.stale).toBe(false);
  });

  it("rev > last + 1 marks the scope stale; rev == last + 1 does not", () => {
    load(5);
    st().applyUpserted({ scopeId: S, rev: 6, rows: [upsert({ id: "n1" })] });
    expect(st().byScope[S]!.stale).toBe(false);
    st().applyUpserted({ scopeId: S, rev: 8, rows: [upsert({ id: "n2" })] });
    expect(st().byScope[S]!.stale).toBe(true);
    expect(st().byScope[S]!.rev).toBe(8);
  });

  it("a gap on a removed event also marks stale", () => {
    load(1);
    st().applyRemoved({ scopeId: S, rev: 4, ids: ["a"], reason: "removed" });
    expect(st().byScope[S]!.stale).toBe(true);
  });

  it("markAllStale (ws:open / ws:resync) flags every loaded scope, even at an unchanged rev", () => {
    load(9);
    st().replace("wt2", "worktree", { rev: 0, cap: 500, total: 0, items: [] });
    st().markAllStale();
    expect(st().byScope[S]!.stale).toBe(true);
    expect(st().byScope.wt2!.stale).toBe(true);
  });

  it("a fresh list after a daemon restart (rev reset to a lower value) replaces the old counter", () => {
    load(50);
    st().replace(S, "worktree", { rev: 0, cap: 500, total: 0, items: [] });
    expect(st().byScope[S]!.rev).toBe(0);
    st().applyUpserted({ scopeId: S, rev: 1, rows: [upsert({ id: "n" }, true)] });
    expect(rowsFor(st(), S).map((r) => r.id)).toEqual(["n"]);
  });

  it("events for a scope that was never loaded are ignored", () => {
    st().applyUpserted({ scopeId: "other", rev: 1, rows: [upsert({ id: "x" }, true)] });
    expect(st().byScope.other).toBeUndefined();
  });

  it("a moved row (same id, new path) updates byPath", () => {
    load(1, [makeRow({ id: "a", path: "/repo/docs/a.md", displayPath: "docs/a.md" })]);
    expect(byPath(st(), S, "docs/a.md")?.id).toBe("a");
    st().applyUpserted({ scopeId: S, rev: 2, rows: [upsert({ id: "a", path: "/repo/docs/a2.md", displayPath: "docs/a2.md" })] });
    expect(byPath(st(), S, "docs/a.md")).toBeUndefined();
    expect(byPath(st(), S, "/repo/docs/a2.md")?.id).toBe("a");
  });

  it("byPath: absolute path matches any row; the display path matches only in-repo rows", () => {
    load(1, [
      makeRow({ id: "out", path: "/tmp/x.md", displayPath: "/tmp/x.md", inRepo: false }),
      makeRow({ id: "in", path: "/repo/a.md", displayPath: "a.md" }),
    ]);
    expect(byPath(st(), S, "/tmp/x.md")?.id).toBe("out");
    expect(byPath(st(), S, "/repo/a.md")?.id).toBe("in");
    expect(byPath(st(), S, "a.md")?.id).toBe("in");
  });

  it("a cli add outside the repo raises the added notice; in-repo and non-created do not", () => {
    load();
    st().applyUpserted({ scopeId: S, rev: 2, rows: [upsert({ id: "in", addedVia: "cli", inRepo: true }, true)] });
    expect(st().byScope[S]!.addedNotice).toBeUndefined();
    st().applyUpserted({ scopeId: S, rev: 3, rows: [upsert({ id: "a", addedVia: "cli", inRepo: false }, false)] });
    expect(st().byScope[S]!.addedNotice).toBeUndefined();
    st().applyUpserted({ scopeId: S, rev: 4, rows: [upsert({ id: "out", addedVia: "cli", inRepo: false }, true)] });
    expect(st().byScope[S]!.addedNotice).toMatchObject({ row: { id: "out" } });
  });

  it("a cap removal then an added upsert keep both notices; dismissing one leaves the other", () => {
    load(1, [makeRow({ id: "a" }), makeRow({ id: "b" }), makeRow({ id: "c" }), makeRow({ id: "d" })]);
    st().applyRemoved({ scopeId: S, rev: 2, ids: ["b", "c", "d"], reason: "cap" });
    st().applyUpserted({ scopeId: S, rev: 3, rows: [upsert({ id: "out", addedVia: "cli", inRepo: false }, true)] });
    expect(st().byScope[S]!.capNotice?.count).toBe(3);
    expect(st().byScope[S]!.addedNotice).toBeDefined();
    st().dismissNotice(S, "cap");
    expect(st().byScope[S]!.capNotice).toBeUndefined();
    expect(st().byScope[S]!.addedNotice).toBeDefined();
  });

  it("group collapse state survives replace and is removed by dropScope", () => {
    load();
    st().setGroupOpen(S, "run", false);
    load(2);
    expect(st().groupOpen[S]).toEqual({ run: false });
    st().dropScope(S);
    expect(st().groupOpen[S]).toBeUndefined();
  });

  it("an error clears rows (never a stale list under an error)", () => {
    load();
    st().setError(S, "worktree", "boom");
    expect(st().byScope[S]).toMatchObject({ status: "error", rows: [], error: "boom" });
  });

  it("dropScope removes the scope", () => {
    load();
    st().dropScope(S);
    expect(st().byScope[S]).toBeUndefined();
  });
});
