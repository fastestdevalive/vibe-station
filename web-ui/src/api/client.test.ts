import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClientApi } from "./client";

/** Creates a fake WebSocket class that auto-opens and records sent messages. */
function makeFakeWsFactory() {
  const sent: string[] = [];

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0; // CONNECTING initially
    onopen: (() => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;

    constructor(_url: string) {
      // Auto-open in next microtask — matches real WS behavior where handlers
      // are set synchronously after construction, then open fires async.
      Promise.resolve().then(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      });
    }

    send(data: string) {
      sent.push(data);
    }

    close() {
      this.readyState = 3;
    }
  }

  return { FakeWebSocket, sent };
}

// Stub window.location for wsUrl() / baseUrl()
vi.stubGlobal("window", {
  location: { origin: "http://localhost:3000" },
});

/**
 * Parse sent messages and filter to chat:open or chat:close for a session.
 */
function chatMsgsFor(sent: string[], type: "chat:open" | "chat:close", sessionId: string) {
  return sent
    .map((s) => JSON.parse(s) as Record<string, unknown>)
    .filter((m) => m.type === type && m.sessionId === sessionId);
}

/** Controllable WebSocket: lets a test fire onopen/onclose/onmessage by hand. */
function makeControllableWsFactory() {
  const sent: string[] = [];
  const sockets: Array<{
    readyState: number;
    onopen: (() => void) | null;
    onclose: ((ev: { code: number }) => void) | null;
    onerror: (() => void) | null;
    onmessage: ((ev: { data: string }) => void) | null;
    send: (d: string) => void;
    close: () => void;
  }> = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor(_url: string) {
      sockets.push(this);
    }
    send(d: string) {
      sent.push(d);
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  }
  return { FakeWebSocket, sockets, sent };
}

describe("openChat / closeChat refcounting", () => {
  let sent: string[];
  let api: ReturnType<typeof createClientApi>;

  beforeEach(async () => {
    const factory = makeFakeWsFactory();
    vi.stubGlobal("WebSocket", factory.FakeWebSocket);
    sent = factory.sent;
    api = createClientApi();

    // Pre-warm: open a dummy session to establish the WS connection so the
    // onopen replay fires once for "warmup". This ensures subsequent openChat
    // calls hit an already-open WS and we can reason cleanly about counts.
    await api.openChat("__warmup__");
    await api.closeChat("__warmup__");
    // Clear tracking after warmup
    sent.splice(0);
  });

  it("1.T1 — openChat twice for same sessionId: chat:open sent once, second is a no-op on the wire", async () => {
    await api.openChat("sess-a");
    await api.openChat("sess-a"); // refCount 1→2, should NOT send

    const openMsgs = chatMsgsFor(sent, "chat:open", "sess-a");
    expect(openMsgs).toHaveLength(1);
  });

  it("1.T2 — closeChat once after two opens: chat:close not sent, refCount drops to 1", async () => {
    await api.openChat("sess-b");
    await api.openChat("sess-b");
    await api.closeChat("sess-b"); // 2→1, should NOT send close

    const closeMsgs = chatMsgsFor(sent, "chat:close", "sess-b");
    expect(closeMsgs).toHaveLength(0);
  });

  it("1.T3 — closeChat twice after two opens: chat:close sent once on second close", async () => {
    await api.openChat("sess-c");
    await api.openChat("sess-c");
    await api.closeChat("sess-c"); // 2→1, no close
    await api.closeChat("sess-c"); // 1→0, sends close

    const closeMsgs = chatMsgsFor(sent, "chat:close", "sess-c");
    expect(closeMsgs).toHaveLength(1);
  });
});

/**
 * REGRESSION — remote socket cycling (see daemon `connection.ts` header).
 * These tests pin the client-side fixes:
 *  - the reconnect `sinceSeq` cursor advances from `chat:replay` (not just live
 *    `session:message`), and the client pages a bounded `chat:replay` toward
 *    the head while `hasMore` is true;
 *  - the reconnect backoff is NOT reset on every `onopen` — only after the
 *    connection has been stable for ~10s.
 */
describe("socket-cycling fixes (sinceSeq cursor + backoff)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("advances sinceSeq from a bounded chat:replay, pages while hasMore, and replays the delta on reconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { FakeWebSocket, sockets, sent } = makeControllableWsFactory();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = createClientApi();

    api.startConnection();
    sockets[0]!.readyState = 1;
    sockets[0]!.onopen!();
    await api.openChat("sess-x"); // fresh open — no sinceSeq
    sent.splice(0);

    // Server sends a bounded replay page with a forward cursor + hasMore.
    sockets[0]!.onmessage!({
      data: JSON.stringify({
        type: "chat:replay",
        sessionId: "sess-x",
        events: [{ id: "e1", logSeq: 5 }, { id: "e2", logSeq: 7 }],
        nextSeq: 7,
        hasMore: true,
      }),
    });
    // The client immediately pages: re-requests with the advanced cursor.
    const pageReq = sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((m) => m.type === "chat:open" && m.sessionId === "sess-x");
    expect(pageReq?.sinceSeq).toBe(7);

    sent.splice(0);
    // Drop and reconnect — the reconnect must replay the DELTA from seq 7, not
    // the whole tail (otherwise the oversized delta would recur on every drop).
    sockets[0]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBe(2);
    sockets[1]!.readyState = 1;
    sockets[1]!.onopen!();
    const reOpen = sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((m) => m.type === "chat:open" && m.sessionId === "sess-x");
    expect(reOpen?.sinceSeq).toBe(7);
  });

  it("does NOT reset the reconnect backoff on a reconnect onopen before ~10s stable", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { FakeWebSocket, sockets } = makeControllableWsFactory();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = createClientApi();

    api.startConnection();
    sockets[0]!.readyState = 1;
    sockets[0]!.onopen!();

    // First drop: backoff 1000 -> 1700; reconnect waits ~1000ms.
    sockets[0]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(sockets.length).toBe(2);
    sockets[1]!.readyState = 1;
    sockets[1]!.onopen!(); // must NOT reset backoff to 1000 (the old bug)

    // Second drop: if backoff had been reset to 1000 on onopen, the reconnect
    // would fire at ~1000ms. With the fix it waits ~1700ms.
    sockets[1]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets.length).toBe(2); // reconnect not fired yet (backoff kept growing)
    await vi.advanceTimersByTimeAsync(700);
    expect(sockets.length).toBe(3); // fired at ~1700ms
  });
});

/**
 * Phase 3 (file-watch-leak fix) — client-side replay maps (`fileWatches` /
 * `treeWatches`) are refcounted so one consumer's `*:unwatch` doesn't drop the
 * replay entry another still-mounted consumer depends on. The daemon loses its
 * per-connection watch state on a drop, so the reconnect replay is the ONLY
 * thing that keeps the other consumer's live updates flowing — deleting the
 * entry early would silently strand it (the bug this pins).
 */
describe("file:watch / tree:watch reconnect-replay refcounting", () => {
  function fileWatchMsgs(sent: string[]) {
    return sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((m) => m.type === "file:watch");
  }

  it("one consumer unwatching does not drop the replay entry another still holds; it is dropped only when the count reaches zero", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { FakeWebSocket, sockets, sent } = makeControllableWsFactory();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = createClientApi();

    api.startConnection();
    sockets[0]!.readyState = 1;
    sockets[0]!.onopen!();
    sent.splice(0);

    // Two consumers watch the same file path.
    await api.send({ type: "file:watch", worktreeId: "wt1", path: "a.rs" });
    await api.send({ type: "file:watch", worktreeId: "wt1", path: "a.rs" });
    // One consumer unwatches — count 2→1, replay entry must SURVIVE.
    await api.send({ type: "file:unwatch", worktreeId: "wt1", path: "a.rs" });

    sent.splice(0);
    // Drop and reconnect — the still-held watch must be replayed.
    sockets[0]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBe(2);
    sockets[1]!.readyState = 1;
    sockets[1]!.onopen!();
    expect(fileWatchMsgs(sent).filter((m) => m.worktreeId === "wt1" && m.path === "a.rs")).toHaveLength(1);

    // The remaining consumer unwatches — count 1→0, entry dropped. Reconnect
    // must NOT replay it.
    await api.send({ type: "file:unwatch", worktreeId: "wt1", path: "a.rs" });
    sent.splice(0);
    sockets[1]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBe(3);
    sockets[2]!.readyState = 1;
    sockets[2]!.onopen!();
    expect(fileWatchMsgs(sent).filter((m) => m.worktreeId === "wt1" && m.path === "a.rs")).toHaveLength(0);
  });

  // Regression: the test above never leaves a key's replay count above 1
  // before a reconnect (it unwatches down to 1 first), so it can't tell the
  // fixed "replay N times" behavior apart from the old "replay once per key
  // regardless of count" bug — both produce exactly one replayed message in
  // that test. This one keeps count at 2 heading into a reconnect and checks
  // the wire directly: the daemon's `retain_file_watcher`/`retain_tree_watcher`
  // only take ONE global ref per (connection, key), and a repeat `*:watch`
  // for a key the (new, post-reconnect) connection already holds locally just
  // bumps ITS OWN local refcount without re-touching the shared registry — so
  // replaying a key exactly as many times as it has local subscribers is what
  // rebuilds the connection's local refcount to match reality. Replay it only
  // once (the bug) and the daemon's post-reconnect local refcount for that key
  // is 1 instead of 2: the first of the two consumers to unwatch releases the
  // connection's only global ref and closes the watcher out from under the
  // second, still-mounted one.
  it("replays a key as many times as it has local subscribers, not once per key — both survive independently after reconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { FakeWebSocket, sockets, sent } = makeControllableWsFactory();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = createClientApi();

    api.startConnection();
    sockets[0]!.readyState = 1;
    sockets[0]!.onopen!();
    sent.splice(0);

    // Two consumers watch the same file path — count stays at 2, neither
    // ever unwatches before the reconnect.
    await api.send({ type: "file:watch", worktreeId: "wt1", path: "a.rs" });
    await api.send({ type: "file:watch", worktreeId: "wt1", path: "a.rs" });

    sent.splice(0);
    sockets[0]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBe(2);
    sockets[1]!.readyState = 1;
    sockets[1]!.onopen!();

    // The replay must send the key TWICE — once per local subscriber this
    // client had — not once per distinct key.
    expect(fileWatchMsgs(sent).filter((m) => m.worktreeId === "wt1" && m.path === "a.rs")).toHaveLength(2);

    // Confirm both consumers really are independent post-reconnect: the
    // first one unwatching must not drop the replay entry the second still
    // needs (same invariant the test above pins, now exercised starting
    // from a post-reconnect state instead of a pre-reconnect one).
    await api.send({ type: "file:unwatch", worktreeId: "wt1", path: "a.rs" });
    sent.splice(0);
    sockets[1]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBe(3);
    sockets[2]!.readyState = 1;
    sockets[2]!.onopen!();
    expect(fileWatchMsgs(sent).filter((m) => m.worktreeId === "wt1" && m.path === "a.rs")).toHaveLength(1);
  });

  // Phase 1 (direct-session file-git parity) — a project-scope watch registered
  // before a disconnect must be replayed WITH `scope: "project"` on reconnect,
  // not silently dropped to worktree-scope (which the daemon's
  // `#[serde(default)]` would default to). This pins 1.7's replay-path edit:
  // the reconnect replay must reproduce the exact message shape it watched with
  // originally, including the `scope` field when it was present.
  it("replays a project-scope file watch with scope=project on reconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { FakeWebSocket, sockets, sent } = makeControllableWsFactory();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = createClientApi();

    api.startConnection();
    sockets[0]!.readyState = 1;
    sockets[0]!.onopen!();
    sent.splice(0);

    await api.send({ type: "file:watch", worktreeId: "proj1", path: "a.rs", scope: "project" });

    sent.splice(0);
    sockets[0]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBe(2);
    sockets[1]!.readyState = 1;
    sockets[1]!.onopen!();

    const replayed = fileWatchMsgs(sent).filter((m) => m.worktreeId === "proj1" && m.path === "a.rs");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.scope).toBe("project");
  });
});

/**
 * Phase 3 (direct-session file-git parity) — the actual client URL-building fix:
 * project-scope git-status / commits calls must route to `/projects/:id/...`
 * instead of `/worktrees/:id/...`. Every component test mocks the API object's
 * methods directly, so nothing pins that `client.ts`'s URL logic itself produces
 * the right path. These stub `fetch` directly and assert the URL.
 */
describe("project-scope URL routing (git-status / commits)", () => {
  let api: ReturnType<typeof createClientApi>;

  beforeEach(() => {
    api = createClientApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listChangedPaths project scope hits /api/projects/<id>/changed-paths", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.listChangedPaths("proj1", "local", undefined, "project");
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/api/projects/proj1/changed-paths");
  });

  it("listChangedPaths default scope (worktree) hits /api/worktrees/<id>/changed-paths", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.listChangedPaths("wt1", "local");
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/api/worktrees/wt1/changed-paths");
  });

  it("listCommits project scope hits /api/projects/<id>/commits", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ commits: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.listCommits("proj1", 200, "project");
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/api/projects/proj1/commits");
  });

  it("listCommits default scope (worktree) hits /api/worktrees/<id>/commits", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ commits: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.listCommits("wt1");
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/api/worktrees/wt1/commits");
  });

  it("getDiff project scope hits /api/projects/<id>/diff/<path>", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(new Response("a diff", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getDiff("proj1", "a.rs", "local", undefined, "project");
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/api/projects/proj1/diff/a.rs");
  });

  it("getDiff default scope (worktree) hits /api/worktrees/<id>/diff/<path>", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(new Response("a diff", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getDiff("wt1", "a.rs", "local");
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/api/worktrees/wt1/diff/a.rs");
  });
});

