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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
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
    onopen: (() => void | Promise<void>) | null;
    onclose: ((ev: { code: number }) => void) | null;
    onerror: (() => void) | null;
    onmessage: ((ev: { data: string }) => void) | null;
    send: (d: string) => void;
    close: (code?: number) => void;
  }> = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    onopen: (() => void | Promise<void>) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor(_url: string) {
      sockets.push(this);
    }
    send(d: string) {
      sent.push(d);
    }
    close(code = 1000) {
      this.readyState = 3;
      this.onclose?.({ code });
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
    await sockets[1]!.onopen!();
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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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
    await sockets[0]!.onopen!();
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
    await sockets[1]!.onopen!();
    expect(fileWatchMsgs(sent).filter((m) => m.worktreeId === "wt1" && m.path === "a.rs")).toHaveLength(1);

    // The remaining consumer unwatches — count 1→0, entry dropped. Reconnect
    // must NOT replay it.
    await api.send({ type: "file:unwatch", worktreeId: "wt1", path: "a.rs" });
    sent.splice(0);
    sockets[1]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBe(3);
    sockets[2]!.readyState = 1;
    await sockets[2]!.onopen!();
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
    await sockets[0]!.onopen!();
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
    await sockets[1]!.onopen!();

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
    await sockets[2]!.onopen!();
    expect(fileWatchMsgs(sent).filter((m) => m.worktreeId === "wt1" && m.path === "a.rs")).toHaveLength(1);
  });
});

describe("pong-liveness timeout (Phase 2)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("2.T1 — force-closes the socket if no inbound frame arrives within 2x PING_INTERVAL_MS of a ping", async () => {
    vi.useFakeTimers();
    const { FakeWebSocket, sockets, sent } = makeControllableWsFactory();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = createClientApi();

    api.startConnection();
    sockets[0]!.readyState = 1;
    await sockets[0]!.onopen!();
    sent.splice(0);

    // Advance to trigger the 25s ping
    await vi.advanceTimersByTimeAsync(25_000);
    expect(sent.map((s) => JSON.parse(s))).toContainEqual({ type: "ping" });
    expect(sockets[0]!.readyState).toBe(1);

    // Advance 50s (2 * 25s) with NO inbound message. Socket must be closed locally.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(sockets[0]!.readyState).toBe(3);
  });

  it("2.T2 — does NOT force-close when pong replies (or any frames) arrive in response to pings", async () => {
    vi.useFakeTimers();
    const { FakeWebSocket, sockets, sent } = makeControllableWsFactory();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = createClientApi();

    api.startConnection();
    sockets[0]!.readyState = 1;
    await sockets[0]!.onopen!();
    sent.splice(0);

    // Advance to trigger first ping
    await vi.advanceTimersByTimeAsync(25_000);
    expect(sent.map((s) => JSON.parse(s))).toContainEqual({ type: "ping" });

    // Respond with a pong before the 50s deadline
    await vi.advanceTimersByTimeAsync(10_000);
    sockets[0]!.onmessage!({ data: JSON.stringify({ type: "pong" }) });

    // Advance past the 50s mark from the ping
    await vi.advanceTimersByTimeAsync(45_000);
    // Connection must still be open
    expect(sockets[0]!.readyState).toBe(1);
  });
});

describe("reconnect bounds and disconnected state (Phase 3)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("3.T2 — settles at 'disconnected' after exceeding MAX_RECONNECT_ATTEMPTS, and retryConnection() resets and reconnects", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { FakeWebSocket, sockets } = makeControllableWsFactory();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = createClientApi();

    api.startConnection();
    sockets[0]!.readyState = 1;
    await sockets[0]!.onopen!();
    expect(api.getConnectionState()).toBe("online");

    // Close initial socket
    sockets[0]!.onclose!({ code: 1006 });
    expect(api.getConnectionState()).toBe("offline");

    // Cycle through 8 reconnect attempts (MAX_RECONNECT_ATTEMPTS = 8)
    const delays = [1100, 1800, 3000, 5000, 8500, 14500, 15500, 15500];
    for (let i = 1; i <= 8; i++) {
      await vi.advanceTimersByTimeAsync(delays[i - 1]!);
      expect(sockets.length).toBe(i + 1);
      // Fail this attempt
      sockets[i]!.onclose!({ code: 1006 });
    }

    // After 8 failures, the 9th scheduleReconnect exceeds MAX_RECONNECT_ATTEMPTS
    expect(api.getConnectionState()).toBe("disconnected");

    // Advancing timers further should NOT spawn any more sockets
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.length).toBe(9);
    expect(api.getConnectionState()).toBe("disconnected");

    // Manual Retry: resets bounds and calls ensureWs() immediately
    api.retryConnection();
    expect(sockets.length).toBe(10);
    expect(api.getConnectionState()).toBe("connecting");

    // When new socket opens successfully, settles back to online
    sockets[9]!.readyState = 1;
    await sockets[9]!.onopen!();
    expect(api.getConnectionState()).toBe("online");
  });
});

describe("reconnect auth gate (Phase 4)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("4.T1 — on reconnect with rejected checkAuth(), closes with 4401, emits auth:expired, never flips to online or emits ws:open", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { FakeWebSocket, sockets } = makeControllableWsFactory();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = createClientApi();

    const authExpiredSpy = vi.fn();
    const wsOpenSpy = vi.fn();
    api.on("auth:expired", authExpiredSpy);
    api.on("ws:open", wsOpenSpy);

    // Initial connection succeeds
    api.startConnection();
    sockets[0]!.readyState = 1;
    await sockets[0]!.onopen!();
    expect(api.getConnectionState()).toBe("online");
    expect(wsOpenSpy).toHaveBeenCalledTimes(1);

    // Disconnect
    sockets[0]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBe(2);

    // Daemon restarted: checkAuth now fails (401)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    sockets[1]!.readyState = 1;
    await sockets[1]!.onopen!();

    // Must NOT emit ws:open or flip to online
    expect(wsOpenSpy).toHaveBeenCalledTimes(1); // still only the initial one
    expect(api.getConnectionState()).not.toBe("online");
    // Must close with 4401 and trigger auth:expired
    expect(sockets[1]!.readyState).toBe(3);
    expect(authExpiredSpy).toHaveBeenCalledTimes(1);
  });

  it("4.T2 — on reconnect with valid checkAuth(), flips to online and emits ws:open exactly once", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { FakeWebSocket, sockets } = makeControllableWsFactory();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = createClientApi();

    const wsOpenSpy = vi.fn();
    api.on("ws:open", wsOpenSpy);

    // Initial connection
    api.startConnection();
    sockets[0]!.readyState = 1;
    await sockets[0]!.onopen!();
    expect(wsOpenSpy).toHaveBeenCalledTimes(1);

    // Disconnect
    sockets[0]!.onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBe(2);

    // Valid auth on reconnect
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    sockets[1]!.readyState = 1;
    await sockets[1]!.onopen!();

    expect(wsOpenSpy).toHaveBeenCalledTimes(2);
    expect(api.getConnectionState()).toBe("online");
  });
});

