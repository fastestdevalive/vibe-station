import { beforeEach, describe, expect, it } from "vitest";
import { restoredGroups, countsByPath, commentsForPath, unsentComments, attachedComments } from "./commentSelectors";
import { makeComment as c, makeDelivery } from "./testFixtures";
import { deriveTrayState } from "./trayState";
import { useCommentStore } from "./useCommentStore";

const list = (comments = [c()], extra: object = {}) => ({ comments, nextPin: 10, terminalDeliveries: [], ...extra });
const st = () => useCommentStore.getState();
const scope = () => st().byScope["wt-1"]!;

beforeEach(() => st().reset());

describe("useCommentStore (4.T5)", () => {
  it("ignores events for a scope nobody requested", () => {
    st().applyChanged({ scopeId: "wt-1", scopeKind: "worktree", upserted: [c()], deleted: [] });
    expect(st().byScope["wt-1"]).toBeUndefined();
  });

  it("upserts and deletes with reasons; another device's delete leaves a notice, our own does not", () => {
    st().replace("wt-1", "worktree", list([c({ id: "a", pin: 1 }), c({ id: "b", pin: 2 })]));
    st().applyChanged({ scopeId: "wt-1", scopeKind: "worktree", upserted: [c({ id: "z", pin: 3 }), c({ id: "a", pin: 1, text: "edited" })], deleted: [] });
    expect(scope().comments.map((x) => x.id)).toEqual(["a", "b", "z"]);
    expect(scope().comments[0]!.text).toBe("edited");

    st().applyChanged({ scopeId: "wt-1", scopeKind: "worktree", upserted: [], deleted: [{ id: "b", reason: "sent" }] });
    expect(scope().removed.b).toMatchObject({ reason: "sent" });

    st().removeLocal("wt-1", ["z"]);
    st().applyChanged({ scopeId: "wt-1", scopeKind: "worktree", upserted: [], deleted: [{ id: "z", reason: "deleted" }] });
    expect(scope().removed.z).toBeUndefined();
    expect(scope().comments.map((x) => x.id)).toEqual(["a"]);

    // the comment came back (restored): the notice goes away
    st().applyChanged({ scopeId: "wt-1", scopeKind: "worktree", upserted: [c({ id: "b", pin: 2 })], deleted: [] });
    expect(scope().removed.b).toBeUndefined();
    // numbering follows the live rows (highest pin + 1), not a never-reused counter
    expect(scope().nextPin).toBe(3);
  });

  it("an event that races the first fetch marks the scope stale instead of applying", () => {
    st().setLoading("wt-1", "worktree");
    st().applyChanged({ scopeId: "wt-1", scopeKind: "worktree", upserted: [c()], deleted: [] });
    expect(scope().stale).toBe(true);
    expect(scope().comments).toEqual([]);
  });

  it("markAllStale (ws:open / ws:resync) flags loaded scopes only", () => {
    st().replace("wt-1", "worktree", list());
    st().markAllStale();
    expect(scope().stale).toBe(true);
    st().replace("wt-1", "worktree", list());
    expect(scope().stale).toBe(false);
  });

  it("a refetch keeps finished deliveries the server no longer lists", () => {
    st().replace("wt-1", "worktree", list());
    st().applyDelivery(makeDelivery({ state: "timed_out" }));
    st().replace("wt-1", "worktree", list());
    expect(scope().deliveries.d1?.state).toBe("timed_out");
  });

  it("selectors: by path, counts, unsent vs attached, restored grouping", () => {
    const rows = [
      c({ id: "a", path: "a.ts" }),
      c({ id: "b", path: "a.ts", attachedTo: "session:s1" }),
      c({ id: "x", path: "b.ts", restoredReason: "turn_cancelled" }),
      c({ id: "y", path: "b.ts", restoredReason: "turn_cancelled" }),
      c({ id: "z", path: "b.ts", restoredReason: "restart" }),
    ];
    expect(commentsForPath(rows, "a.ts")).toHaveLength(2);
    expect(countsByPath(rows).get("b.ts")).toBe(3);
    expect(unsentComments(rows)).toHaveLength(4);
    expect(attachedComments(rows, "session:s1")).toHaveLength(1);
    expect(restoredGroups(rows)).toEqual([
      { reason: "turn_cancelled", ids: ["x", "y"] },
      { reason: "restart", ids: ["z"] },
    ]);
  });
});

describe("deriveTrayState (Send board B)", () => {
  const scopeWith = (comments: ReturnType<typeof c>[], deliveries: ReturnType<typeof makeDelivery>[] = []) => {
    st().replace("wt-1", "worktree", list(comments));
    for (const d of deliveries) st().applyDelivery(d);
    return scope();
  };

  it("hidden with nothing, normal with comments", () => {
    expect(deriveTrayState({ scope: undefined, online: true }).primary.kind).toBe("hidden");
    const s = deriveTrayState({ scope: scopeWith([c({ id: "a" }), c({ id: "b", path: "o.ts" })]), online: true });
    expect(s).toMatchObject({ primary: { kind: "normal" }, count: 2, unsentCount: 2, canSend: true });
    expect(s.files).toEqual([{ path: "src/App.tsx", count: 1 }, { path: "o.ts", count: 1 }]);
  });

  it("attached: '4 attached to main'", () => {
    const s = deriveTrayState({ scope: scopeWith([c({ id: "a", attachedTo: "session:s1" }), c({ id: "b" })]), online: true });
    expect(s.primary).toMatchObject({ kind: "attached", count: 1, composerKeys: ["session:s1"] });
    expect(s.unsentCount).toBe(1);
  });

  it("sending: waiting can cancel, pasting cannot, and new comments stay sendable", () => {
    const waiting = deriveTrayState({ scope: scopeWith([c()], [makeDelivery({ state: "waiting", waitsBehind: 1 })]), online: true });
    expect(waiting.primary).toMatchObject({ kind: "sending", phase: "waiting", canCancel: true });
    expect(waiting.canSend).toBe(true);
    st().applyDelivery(makeDelivery({ state: "pasting", updatedAt: "2026-01-01T00:00:02Z" }));
    expect(deriveTrayState({ scope: scope(), online: true }).primary).toMatchObject({ kind: "sending", phase: "pasting", canCancel: false });
  });

  it("failed sends: timed out, agent exited; restored notice; over limit; offline", () => {
    expect(deriveTrayState({ scope: scopeWith([c()], [makeDelivery({ state: "timed_out" })]), online: true }).primary.kind).toBe("timed_out");
    st().reset();
    expect(deriveTrayState({ scope: scopeWith([c()], [makeDelivery({ state: "failed", reason: "agent_exited" })]), online: true }).primary.kind).toBe("agent_exited");
    st().reset();
    expect(deriveTrayState({ scope: scopeWith([c({ restoredReason: "turn_cancelled" })]), online: true }).primary).toMatchObject({ kind: "restored", count: 1 });
    st().reset();
    const many = Array.from({ length: 212 }, (_, i) => c({ id: `m${i}`, pin: i + 1, blockBytes: 700 }));
    const over = deriveTrayState({ scope: scopeWith(many), online: true });
    expect(over.primary).toMatchObject({ kind: "over_limit", count: 212, overComments: 12 });
    expect(over.canSend).toBe(false);
    st().reset();
    const off = deriveTrayState({ scope: scopeWith([c()]), online: false });
    expect(off).toMatchObject({ offline: true, canSend: false });
  });

  it("nextPin follows the live rows: 1 when empty (after a send), highest + 1 otherwise", () => {
    st().replace("wt-1", "worktree", list([c({ id: "a", pin: 5 })]));
    expect(scope().nextPin).toBe(10); // the server value is taken as sent
    st().applyChanged({ scopeId: "wt-1", scopeKind: "worktree", upserted: [], deleted: [{ id: "a", reason: "sent" }] });
    expect(scope().nextPin).toBe(1);
    st().upsertLocal(c({ id: "n", pin: 1 }));
    expect(scope().comments.map((x) => x.pin)).toEqual([1]);
    expect(scope().nextPin).toBe(2);
  });
});

describe("local delete during an in-flight refetch (L5-25)", () => {
  it("the stale response does not bring the row back and leaves no notice", () => {
    st().replace("wt-1", "worktree", list([c({ id: "a", pin: 1 })]));
    st().setLoading("wt-1", "worktree");
    st().removeLocal("wt-1", ["a"]);
    expect(scope().stale).toBe(true); // a follow-up refetch will confirm
    st().replace("wt-1", "worktree", list([c({ id: "a", pin: 1 })]));
    expect(scope().comments).toHaveLength(0);
    expect(scope().removed["a"]).toBeUndefined();
  });
});
