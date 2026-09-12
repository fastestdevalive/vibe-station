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
  /** Controllable WebSocket: lets the test fire onopen/onclose/onmessage by hand. */
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
