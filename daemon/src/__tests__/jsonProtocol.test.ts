import { describe, it, expect } from "vitest";
import {
  ClientMessage,
  ServerMessage,
  NormalizedEventSchema,
} from "../ws/protocol.js";
import type { NormalizedEvent } from "../types.js";

const validEvent: NormalizedEvent = {
  id: "e1",
  sessionId: "s1",
  ts: new Date().toISOString(),
  provider: "claude",
  kind: "text",
  role: "assistant",
  text: "hi",
};

describe("ws protocol — JSON agent chat schemas (1.T2)", () => {
  it("valid chat:open parses (C→S)", () => {
    const res = ClientMessage.safeParse({ type: "chat:open", sessionId: "s1" });
    expect(res.success).toBe(true);
  });

  it("valid chat:close parses (C→S)", () => {
    const res = ClientMessage.safeParse({ type: "chat:close", sessionId: "s1" });
    expect(res.success).toBe(true);
  });

  it("valid session:message parses (S→C)", () => {
    const res = ServerMessage.safeParse({
      type: "session:message",
      sessionId: "s1",
      event: validEvent,
    });
    expect(res.success).toBe(true);
  });

  it("malformed session:message (bad event.kind) is rejected", () => {
    const res = ServerMessage.safeParse({
      type: "session:message",
      sessionId: "s1",
      event: { ...validEvent, kind: "not-a-kind" },
    });
    expect(res.success).toBe(false);
  });

  it("malformed session:message (missing event) is rejected", () => {
    const res = ServerMessage.safeParse({ type: "session:message", sessionId: "s1" });
    expect(res.success).toBe(false);
  });

  it("session:meta parses with a full SessionMeta", () => {
    const res = ServerMessage.safeParse({
      type: "session:meta",
      sessionId: "s1",
      meta: {
        sessionId: "s1",
        channel: "json",
        cli: "claude",
        turnState: "responding",
        queueDepth: 0,
        queuedTurnIds: [],
        editingTurnIds: [],
      },
    });
    expect(res.success).toBe(true);
  });

  it("session:meta carries queued + editing turnIds (queue-controls A6)", () => {
    const res = ServerMessage.safeParse({
      type: "session:meta",
      sessionId: "s1",
      meta: {
        sessionId: "s1",
        channel: "json",
        cli: "claude",
        turnState: "queued",
        queueDepth: 2,
        queuedTurnIds: ["t1", "t2"],
        editingTurnIds: ["t3"],
      },
    });
    expect(res.success).toBe(true);
  });

  it("session:meta MISSING queuedTurnIds/editingTurnIds is rejected (mirror invariant)", () => {
    const res = ServerMessage.safeParse({
      type: "session:meta",
      sessionId: "s1",
      meta: { sessionId: "s1", channel: "json", cli: "claude", turnState: "idle", queueDepth: 0 },
    });
    expect(res.success).toBe(false);
  });

  it("a superseding user event carries edited:true (queue-controls A7)", () => {
    const res = NormalizedEventSchema.safeParse({
      ...validEvent,
      kind: "user",
      role: "user",
      turnId: "t1",
      edited: true,
    });
    expect(res.success).toBe(true);
  });

  it("chat:replay parses with an events array", () => {
    const res = ServerMessage.safeParse({
      type: "chat:replay",
      sessionId: "s1",
      events: [validEvent],
    });
    expect(res.success).toBe(true);
  });

  it("P1 — chat:open carries an optional sinceSeq reconnect cursor (C→S)", () => {
    expect(ClientMessage.safeParse({ type: "chat:open", sessionId: "s1", sinceSeq: 12 }).success).toBe(
      true,
    );
    // Still valid without it (fresh open).
    expect(ClientMessage.safeParse({ type: "chat:open", sessionId: "s1" }).success).toBe(true);
  });

  it("P1 — chat:replay carries the { oldestSeq, hasMore } keyset cursor (S→C)", () => {
    const res = ServerMessage.safeParse({
      type: "chat:replay",
      sessionId: "s1",
      events: [{ ...validEvent, logSeq: 40 }],
      oldestSeq: 40,
      hasMore: true,
    });
    expect(res.success).toBe(true);
  });

  it("P1 — NormalizedEvent carries the durable logSeq cursor", () => {
    expect(NormalizedEventSchema.safeParse({ ...validEvent, logSeq: 7 }).success).toBe(true);
  });

  it("NormalizedEvent enum includes 'user' and 'status'", () => {
    expect(NormalizedEventSchema.safeParse({ ...validEvent, kind: "user", role: "user" }).success).toBe(
      true,
    );
    expect(NormalizedEventSchema.safeParse({ ...validEvent, kind: "status" }).success).toBe(true);
  });

  it("session:created snapshot carries channel", () => {
    const res = ServerMessage.safeParse({
      type: "session:created",
      sessionId: "s1",
      worktreeId: "wt-1",
      sessionType: "agent",
      snapshot: {
        id: "s1",
        worktreeId: "wt-1",
        slot: "m",
        type: "agent",
        modeId: null,
        label: "main",
        tmuxName: "t",
        channel: "json",
        state: "not_started",
        lifecycleState: "not_started",
        createdAt: new Date().toISOString(),
      },
    });
    expect(res.success).toBe(true);
    if (res.success && res.data.type === "session:created") {
      expect(res.data.snapshot?.channel).toBe("json");
    }
  });
});
