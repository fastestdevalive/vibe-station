import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClientApi } from "./client";
import { ReviewApiError } from "./errors";
import { createMockApi } from "./mock";

vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });

let fetchMock: ReturnType<typeof vi.fn>;
type Call = [input: string, init?: RequestInit];

function res(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, statusText: "", headers: new Headers(), json: async () => body, text: async () => text };
}
const body = (n: number) => JSON.parse((fetchMock.mock.calls[n] as Call)[1]!.body as string);

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("comments client methods (4.2)", () => {
  it("list / create / patch / delete hit the worktree, project and comment routes", async () => {
    fetchMock.mockResolvedValue(res(200, { comments: [], nextPin: 1, terminalDeliveries: [], comment: { id: "c" }, ok: true }));
    const api = createClientApi();
    await api.listComments("w 1", "worktree", { path: "a b.ts", delivery: "unsent" });
    await api.listComments("p1", "project");
    expect((fetchMock.mock.calls[0] as Call)[0]).toBe("/api/worktrees/w%201/comments?path=a+b.ts&delivery=unsent");
    expect((fetchMock.mock.calls[1] as Call)[0]).toBe("/api/projects/p1/comments");
    const created = await api.createComment("w1", "worktree", { id: "c", path: "a.ts", pathKind: "repo", surface: "file", quote: "q", prefix: "", suffix: "", occurrence: 0, text: "t" });
    expect(created).toEqual({ id: "c" });
    expect((fetchMock.mock.calls[2] as Call)[0]).toBe("/api/worktrees/w1/comments");
    expect((fetchMock.mock.calls[2] as Call)[1]?.method).toBe("POST");
    await api.patchComment("c", { text: "x", version: 2 });
    expect((fetchMock.mock.calls[3] as Call)[0]).toBe("/api/comments/c");
    expect((fetchMock.mock.calls[3] as Call)[1]?.method).toBe("PATCH");
    expect(body(3)).toEqual({ text: "x", version: 2 });
    await api.deleteComment("c");
    expect((fetchMock.mock.calls[4] as Call)[1]?.method).toBe("DELETE");
  });

  it("attach / detach / render / dismiss-restored / restore-review / terminal deliveries / readiness", async () => {
    fetchMock.mockResolvedValue(res(200, { attached: [], detached: [], text: "", bytes: 0, count: 0, cleared: 0, restored: 1, skipped: 0, delivery: { id: "d" }, readiness: "ready", ok: true }));
    const api = createClientApi();
    await api.attachComments("w", "worktree", { composerKey: "session:s", refreshOnly: true });
    expect((fetchMock.mock.calls[0] as Call)[0]).toBe("/api/worktrees/w/comments/attach");
    expect(body(0)).toEqual({ composerKey: "session:s", refreshOnly: true });
    await api.detachComments("w", "worktree", { composerKey: "session:s" });
    expect((fetchMock.mock.calls[1] as Call)[0]).toBe("/api/worktrees/w/comments/detach");
    await api.renderComments("p", "project", { commentIds: ["a"], message: "hi" });
    expect((fetchMock.mock.calls[2] as Call)[0]).toBe("/api/projects/p/comments/render");
    await api.dismissRestoredComments("w", "worktree");
    expect((fetchMock.mock.calls[3] as Call)[0]).toBe("/api/worktrees/w/comments/dismiss-restored");
    expect(await api.restoreReview("s1", "t1")).toMatchObject({ restored: 1 });
    expect((fetchMock.mock.calls[4] as Call)[0]).toBe("/api/sessions/s1/chat/turns/t1/restore-review");
    await api.createTerminalDelivery("w", "worktree", { terminalDeliveryId: "d", sessionId: "s", commentIds: ["a"] });
    expect((fetchMock.mock.calls[5] as Call)[0]).toBe("/api/worktrees/w/terminal-deliveries");
    await api.cancelTerminalDelivery("d");
    expect((fetchMock.mock.calls[6] as Call)[0]).toBe("/api/terminal-deliveries/d");
    expect((fetchMock.mock.calls[6] as Call)[1]?.method).toBe("DELETE");
    expect(await api.terminalReadiness("s")).toBe("ready");
    expect((fetchMock.mock.calls[7] as Call)[0]).toBe("/api/sessions/s/terminal-readiness");
  });

  it("failures are ReviewApiError carrying the daemon's error code and remaining / limit / unit", async () => {
    fetchMock.mockResolvedValueOnce(res(409, { error: "comments_changed", message: "changed", remaining: 2 }));
    const api = createClientApi();
    const err = await api.sendChat("s", "", undefined, true, undefined, ["a", "b", "c"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewApiError);
    expect(err).toMatchObject({ status: 409, code: "comments_changed", info: { remaining: 2 } });
    fetchMock.mockResolvedValueOnce(res(413, { error: "review_too_large", message: "big", limit: 131072, unit: "bytes" }));
    const err2 = await api.createTerminalDelivery("w", "worktree", { terminalDeliveryId: "d", sessionId: "s", commentIds: ["a"] }).catch((e: unknown) => e);
    expect(err2).toMatchObject({ code: "review_too_large", info: { limit: 131072, unit: "bytes" } });
  });

  it("sendChat / scheduleMessage carry reviewCommentIds only when given", async () => {
    fetchMock.mockResolvedValue(res(202, { turnId: "t", id: "i", fireAt: "x" }));
    const api = createClientApi();
    await api.sendChat("s", "hi");
    expect(body(0)).toEqual({ message: "hi" });
    await api.sendChat("s", "", undefined, true, undefined, ["a"]);
    expect(body(1)).toEqual({ message: "", queue: true, reviewCommentIds: ["a"] });
    await api.scheduleMessage("s", "", "2030-01-01T00:00:00Z", undefined, ["a", "b"]);
    expect(body(2)).toEqual({ message: "", fireAt: "2030-01-01T00:00:00Z", reviewCommentIds: ["a", "b"] });
    await api.scheduleMessage("s", "m", "2030-01-01T00:00:00Z");
    expect(body(3)).toEqual({ message: "m", fireAt: "2030-01-01T00:00:00Z" });
  });

  it("resubmitQueuedTurn keepReview and startDraft reviewCommentIds are passed through", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true, turnId: "t" }));
    const api = createClientApi();
    await api.resubmitQueuedTurn("s", "t", { edited: false, keepReview: false });
    expect(body(0)).toEqual({ edited: false, keepReview: false });
    await api.startDraft("d", { draftPrompt: "", draftConfig: {} as never, reviewCommentIds: ["a"] });
    expect(body(1)).toMatchObject({ draftPrompt: "", reviewCommentIds: ["a"] });
  });
});

describe("mock comments (4.2)", () => {
  const mk = (id: string, n = 1) => ({ id, path: "a.ts", pathKind: "repo" as const, surface: "file" as const, quote: "q", prefix: "", suffix: "", occurrence: 0, text: `t${n}`, lineStart: n });

  it("create is idempotent by id, pins are per-scope (max+1 of existing rows), caps and sizes match the daemon", async () => {
    const api = createMockApi();
    const a = await api.createComment("wt-1", "worktree", mk("a"));
    expect((await api.createComment("wt-1", "worktree", mk("a"))).pin).toBe(a.pin);
    const b = await api.createComment("wt-1", "worktree", mk("b", 2));
    expect([a.pin, b.pin]).toEqual([1, 2]);
    await api.deleteComment("b");
    expect((await api.createComment("wt-1", "worktree", mk("c", 3))).pin).toBe(2);
    await api.deleteComment("a");
    await api.deleteComment("c");
    expect((await api.createComment("wt-1", "worktree", mk("d", 4))).pin).toBe(1);
    await expect(api.createComment("wt-1", "worktree", { ...mk("big"), text: "x".repeat(8193) })).rejects.toMatchObject({ code: "text_too_long", status: 413 });
    await expect(api.createComment("wt-1", "worktree", { ...mk("bigq"), quote: "x".repeat(2049) })).rejects.toMatchObject({ code: "quote_too_long" });
    await expect(api.patchComment("nope", { text: "x" })).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("emits comments:changed for create / patch / delete", async () => {
    const api = createMockApi();
    const seen: unknown[] = [];
    api.on("comments:changed", (e) => seen.push(e));
    await api.createComment("wt-1", "worktree", mk("a"));
    await api.patchComment("a", { text: "new" });
    await api.deleteComment("a");
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ deleted: [{ id: "a", reason: "deleted" }], upserted: [] });
  });

  it("attach moves comments to a composer, detach releases; sendChat with ids consumes them (reason sent) and the turn carries the review", async () => {
    const api = createMockApi();
    await api.createComment("wt-1", "worktree", mk("a"));
    await api.createComment("wt-1", "worktree", mk("b", 2));
    expect((await api.attachComments("wt-1", "worktree", { composerKey: "session:s1" })).attached).toEqual(["a", "b"]);
    expect((await api.listComments("wt-1", "worktree", { delivery: "unsent" })).comments).toHaveLength(0);
    await api.detachComments("wt-1", "worktree", { commentIds: ["b"] });
    expect((await api.listComments("wt-1", "worktree", { delivery: "unsent" })).comments.map((c) => c.id)).toEqual(["b"]);
    const events: unknown[] = [];
    api.on("session:message", (e) => events.push(e));
    const deleted: unknown[] = [];
    api.on("comments:changed", (e) => deleted.push(e));
    await api.sendChat("s1", "", undefined, true, undefined, ["a", "b"]);
    expect((events[0] as { event: { review?: { comments: unknown[] } } }).event.review?.comments).toHaveLength(2);
    expect(deleted[0]).toMatchObject({ deleted: [{ reason: "sent" }, { reason: "sent" }] });
    await expect(api.sendChat("s1", "", undefined, true, undefined, ["a"])).rejects.toMatchObject({ code: "comments_changed" });
  });

  it("terminal delivery: in-flight guard, cancel restores with a notice, timeout restores", async () => {
    const api = createMockApi();
    await api.createComment("wt-1", "worktree", mk("a"));
    await api.createComment("wt-1", "worktree", mk("b", 2));
    const d1 = await api.createTerminalDelivery("wt-1", "worktree", { terminalDeliveryId: "d1", sessionId: "s", commentIds: ["a"] });
    expect(d1.delivery.state).toBe("waiting");
    await expect(api.createTerminalDelivery("wt-1", "worktree", { terminalDeliveryId: "d2", sessionId: "s", commentIds: ["b"] })).rejects.toMatchObject({ code: "delivery_in_flight" });
    expect((await api.listComments("wt-1", "worktree")).terminalDeliveries).toHaveLength(1);
    await api.cancelTerminalDelivery("d1");
    const after = (await api.listComments("wt-1", "worktree")).comments.find((c) => c.id === "a");
    expect(after?.restoredReason).toBe("send_cancelled");
    await api.createTerminalDelivery("wt-1", "worktree", { terminalDeliveryId: "d3", sessionId: "s", commentIds: ["a"] });
    api.__comments.setDeliveryState("d3", "pasting");
    await expect(api.cancelTerminalDelivery("d3")).rejects.toMatchObject({ code: "delivery_pasting" });
    api.__comments.setDeliveryState("d3", "timed_out");
    expect((await api.listComments("wt-1", "worktree")).comments.find((c) => c.id === "a")?.restoredReason).toBe("timed_out");
    expect((await api.dismissRestoredComments("wt-1", "worktree")).cleared).toBeGreaterThan(0);
  });

  it("schedule with ids snapshots the comments; cancelling the schedule restores them", async () => {
    const api = createMockApi({
      sessions: [
        { id: "s1", worktreeId: "wt-1", projectId: "proj-a", modeId: "mode-1", type: "agent", isMain: false, state: "idle", lifecycleState: "idle", tmuxName: "s1", createdAt: "2026-01-01T00:00:00Z", sortOrder: 1, channel: "json" },
      ],
    });
    await api.createComment("wt-1", "worktree", mk("a"));
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const sched = await api.scheduleMessage("s1", "", when, undefined, ["a"]);
    expect((await api.listComments("wt-1", "worktree")).comments).toHaveLength(0);
    expect((await api.getScheduledMessages("s1")).scheduledSends[0]).toMatchObject({ commentCount: 1 });
    await api.cancelScheduledMessage("s1", sched.id);
    const back = (await api.listComments("wt-1", "worktree")).comments;
    expect(back).toHaveLength(1);
    expect(back[0]!.restoredReason).toBe("schedule_cancelled");
  });
});
