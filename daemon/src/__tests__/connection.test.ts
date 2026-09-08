/**
 * `WSConnection`'s refcounted watcher maps (Decision 8,
 * `.vibekit/feature-plans/pending/ui-improvements/plan-ui-improvements.md`).
 *
 * The tree/file watcher maps went from `Map<string, unknown>` (one watcher
 * per key, no awareness of multiple consumers) to
 * `Map<string, { watcher, refCount }>` — this suite proves the retain/
 * release contract: a second consumer's watch retains rather than
 * double-creating, an unwatch only actually closes the watcher once every
 * consumer has released it, and the watcher's own `error` path force-removes
 * the entry regardless of refCount (a genuinely dead watcher can't serve any
 * retainer, so a partial decrement would leave a stale, unusable entry).
 */
import { describe, it, expect, vi } from "vitest";
import { WSConnection } from "../ws/connection.js";

function makeConn(): WSConnection {
  const fakeWs = { readyState: 1, send: vi.fn(), bufferedAmount: 0 } as unknown as ConstructorParameters<
    typeof WSConnection
  >[0];
  return new WSConnection(fakeWs);
}

describe("WSConnection tree watcher refcounting", () => {
  it("retainTreeWatcher returns false for an unknown key", () => {
    const conn = makeConn();
    expect(conn.retainTreeWatcher("tree:wt-1:")).toBe(false);
  });

  it("retainTreeWatcher returns true for an existing key without creating a second watcher", () => {
    const conn = makeConn();
    const watcher = { closed: false };
    conn.registerTreeWatcher("tree:wt-1:", watcher);

    expect(conn.retainTreeWatcher("tree:wt-1:")).toBe(true);
    // Still exactly one entry, same watcher instance, refCount bumped.
    expect(conn.treeWatches.size).toBe(1);
    expect(conn.treeWatches.get("tree:wt-1:")?.watcher).toBe(watcher);
    expect(conn.treeWatches.get("tree:wt-1:")?.refCount).toBe(2);
  });

  it("releaseTreeWatcher returns null while refCount > 0, and the watcher once it hits 0", () => {
    const conn = makeConn();
    const watcher = { closed: false };
    conn.registerTreeWatcher("tree:wt-1:", watcher); // refCount: 1
    conn.retainTreeWatcher("tree:wt-1:"); // refCount: 2

    expect(conn.releaseTreeWatcher("tree:wt-1:")).toBeNull(); // -> refCount 1, still held
    expect(conn.treeWatches.has("tree:wt-1:")).toBe(true);

    expect(conn.releaseTreeWatcher("tree:wt-1:")).toBe(watcher); // -> refCount 0, closed
    expect(conn.treeWatches.has("tree:wt-1:")).toBe(false);
  });

  it("releaseTreeWatcher on an unknown key returns null and does not throw", () => {
    const conn = makeConn();
    expect(conn.releaseTreeWatcher("tree:unknown:")).toBeNull();
  });

  it("simulated two-consumer watch/unwatch: watcher stays open until the second unwatch", () => {
    // Simulates FileTreeSidebar + Quick Open both calling tree:watch for the
    // same worktree/connection, then one tearing down.
    const conn = makeConn();
    const watcher = { closed: false };

    // First consumer (FileTreeSidebar): no existing entry -> register.
    expect(conn.retainTreeWatcher("tree:wt-1:")).toBe(false);
    conn.registerTreeWatcher("tree:wt-1:", watcher);

    // Second consumer (Quick Open): entry exists -> retain, no new watcher.
    expect(conn.retainTreeWatcher("tree:wt-1:")).toBe(true);

    // One consumer unwatches — watcher must still be open.
    expect(conn.releaseTreeWatcher("tree:wt-1:")).toBeNull();
    expect(conn.treeWatches.get("tree:wt-1:")?.refCount).toBe(1);

    // Second consumer unwatches — now it actually closes.
    expect(conn.releaseTreeWatcher("tree:wt-1:")).toBe(watcher);
    expect(conn.treeWatches.has("tree:wt-1:")).toBe(false);
  });

  it("unregisterTreeWatcher force-removes the entry regardless of refCount (error-path teardown)", () => {
    const conn = makeConn();
    const watcher = { closed: false };
    conn.registerTreeWatcher("tree:wt-1:", watcher); // refCount: 1
    conn.retainTreeWatcher("tree:wt-1:"); // refCount: 2

    conn.unregisterTreeWatcher("tree:wt-1:");

    expect(conn.treeWatches.has("tree:wt-1:")).toBe(false);
    // A subsequent tree:watch must create a fresh watcher rather than
    // retaining a stale entry.
    expect(conn.retainTreeWatcher("tree:wt-1:")).toBe(false);
  });

  it("a stale retainer's unwatch after a force-delete does not close a new watcher registered under the same key", () => {
    // Regression for the "one consumer's unmount kills another's watcher"
    // bug reintroduced via the error/force-delete path: watcher A dies while
    // still held by 2 retainers (force-delete, not decrement); a third,
    // unrelated consumer then starts a fresh watch under the SAME key; one
    // of the two original (now-stale) retainers finally calls tree:unwatch,
    // not knowing A already died. That stale unwatch must be a no-op against
    // the new watcher B, not close it.
    const conn = makeConn();
    const watcherA = { closed: false };
    conn.registerTreeWatcher("tree:wt-1:", watcherA); // refCount: 1
    conn.retainTreeWatcher("tree:wt-1:"); // refCount: 2 (two retainers)

    // watcherA's own `error` listener force-deletes the entry while refCount
    // is still 2.
    conn.unregisterTreeWatcher("tree:wt-1:");
    expect(conn.treeWatches.has("tree:wt-1:")).toBe(false);

    // A third, unrelated consumer starts a fresh watch under the same key.
    const watcherB = { closed: false };
    expect(conn.retainTreeWatcher("tree:wt-1:")).toBe(false);
    conn.registerTreeWatcher("tree:wt-1:", watcherB); // refCount: 1

    // One of the two stale retainers from watcherA's generation finally
    // calls tree:unwatch. Must no-op — watcherB must stay open.
    expect(conn.releaseTreeWatcher("tree:wt-1:")).toBeNull();
    expect(conn.treeWatches.get("tree:wt-1:")?.watcher).toBe(watcherB);
    expect(conn.treeWatches.get("tree:wt-1:")?.refCount).toBe(1);

    // The second stale retainer also eventually calls unwatch — still a
    // no-op (debt fully drained now), watcherB still stays open.
    expect(conn.releaseTreeWatcher("tree:wt-1:")).toBeNull();
    expect(conn.treeWatches.get("tree:wt-1:")?.watcher).toBe(watcherB);
    expect(conn.treeWatches.get("tree:wt-1:")?.refCount).toBe(1);

    // Now the legitimate (third) consumer unwatches — this one actually
    // closes watcherB.
    expect(conn.releaseTreeWatcher("tree:wt-1:")).toBe(watcherB);
    expect(conn.treeWatches.has("tree:wt-1:")).toBe(false);
  });
});

describe("WSConnection file watcher refcounting", () => {
  it("retainFileWatcher returns false for an unknown key", () => {
    const conn = makeConn();
    expect(conn.retainFileWatcher("file:wt-1:a.txt")).toBe(false);
  });

  it("retainFileWatcher returns true for an existing key without creating a second watcher", () => {
    const conn = makeConn();
    const watcher = { closed: false };
    conn.registerFileWatcher("file:wt-1:a.txt", watcher);

    expect(conn.retainFileWatcher("file:wt-1:a.txt")).toBe(true);
    expect(conn.fileWatches.size).toBe(1);
    expect(conn.fileWatches.get("file:wt-1:a.txt")?.watcher).toBe(watcher);
    expect(conn.fileWatches.get("file:wt-1:a.txt")?.refCount).toBe(2);
  });

  it("releaseFileWatcher returns null while refCount > 0, and the watcher once it hits 0", () => {
    const conn = makeConn();
    const watcher = { closed: false };
    conn.registerFileWatcher("file:wt-1:a.txt", watcher);
    conn.retainFileWatcher("file:wt-1:a.txt");

    expect(conn.releaseFileWatcher("file:wt-1:a.txt")).toBeNull();
    expect(conn.releaseFileWatcher("file:wt-1:a.txt")).toBe(watcher);
    expect(conn.fileWatches.has("file:wt-1:a.txt")).toBe(false);
  });

  it("unregisterFileWatcher force-removes the entry regardless of refCount (error-path teardown)", () => {
    const conn = makeConn();
    const watcher = { closed: false };
    conn.registerFileWatcher("file:wt-1:a.txt", watcher);
    conn.retainFileWatcher("file:wt-1:a.txt");

    conn.unregisterFileWatcher("file:wt-1:a.txt");

    expect(conn.fileWatches.has("file:wt-1:a.txt")).toBe(false);
    expect(conn.retainFileWatcher("file:wt-1:a.txt")).toBe(false);
  });

  it("a stale retainer's unwatch after a force-delete does not close a new watcher registered under the same key", () => {
    const conn = makeConn();
    const watcherA = { closed: false };
    conn.registerFileWatcher("file:wt-1:a.txt", watcherA); // refCount: 1
    conn.retainFileWatcher("file:wt-1:a.txt"); // refCount: 2

    conn.unregisterFileWatcher("file:wt-1:a.txt");
    expect(conn.fileWatches.has("file:wt-1:a.txt")).toBe(false);

    const watcherB = { closed: false };
    conn.registerFileWatcher("file:wt-1:a.txt", watcherB); // refCount: 1

    expect(conn.releaseFileWatcher("file:wt-1:a.txt")).toBeNull();
    expect(conn.releaseFileWatcher("file:wt-1:a.txt")).toBeNull();
    expect(conn.fileWatches.get("file:wt-1:a.txt")?.watcher).toBe(watcherB);
    expect(conn.fileWatches.get("file:wt-1:a.txt")?.refCount).toBe(1);

    expect(conn.releaseFileWatcher("file:wt-1:a.txt")).toBe(watcherB);
    expect(conn.fileWatches.has("file:wt-1:a.txt")).toBe(false);
  });
});

describe("WSConnection.cleanup closes watchers regardless of refCount", () => {
  it("closes both tree and file watchers with refCount > 1 during cleanup", async () => {
    const conn = makeConn();
    const treeWatcher = { close: vi.fn(async () => {}) };
    const fileWatcher = { close: vi.fn(async () => {}) };
    conn.registerTreeWatcher("tree:wt-1:", treeWatcher);
    conn.retainTreeWatcher("tree:wt-1:");
    conn.registerFileWatcher("file:wt-1:a.txt", fileWatcher);
    conn.retainFileWatcher("file:wt-1:a.txt");

    await conn.cleanup();

    expect(treeWatcher.close).toHaveBeenCalledTimes(1);
    expect(fileWatcher.close).toHaveBeenCalledTimes(1);
    expect(conn.treeWatches.size).toBe(0);
    expect(conn.fileWatches.size).toBe(0);
  });
});
