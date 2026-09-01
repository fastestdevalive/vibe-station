import { describe, it, expect, vi, beforeEach } from "vitest";
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
