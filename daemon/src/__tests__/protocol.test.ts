import { describe, it, expect } from "vitest";
import { ServerMessage } from "../ws/protocol.js";

// 1.T5 (plan 03, "Interaction States"): the WS protocol's `session:state`
// schema is a hardcoded `z.enum([...])`, NOT derived from `LifecycleState`
// (see plan Research §Protocol) — widening the daemon's `LifecycleState` TS
// type does not widen this zod schema. This is a regression guard for 1.7's
// edit to `daemon/src/ws/protocol.ts`'s three duplicated enum lists.
describe("ws protocol — session:state accepts the new LifecycleState values (1.T5)", () => {
  it("parses a session:state broadcast with state: 'waiting_for_human'", () => {
    const msg = {
      type: "session:state",
      sessionId: "sess-1",
      state: "waiting_for_human",
    };
    expect(() => ServerMessage.parse(msg)).not.toThrow();
    const parsed = ServerMessage.parse(msg);
    expect(parsed).toMatchObject({ type: "session:state", state: "waiting_for_human" });
  });

  it("parses a session:state broadcast with state: 'needs_review'", () => {
    const msg = {
      type: "session:state",
      sessionId: "sess-2",
      state: "needs_review",
    };
    expect(() => ServerMessage.parse(msg)).not.toThrow();
    const parsed = ServerMessage.parse(msg);
    expect(parsed).toMatchObject({ type: "session:state", state: "needs_review" });
  });

  it("still rejects an unknown/invalid state value", () => {
    const msg = {
      type: "session:state",
      sessionId: "sess-3",
      state: "totally_made_up",
    };
    expect(() => ServerMessage.parse(msg)).toThrow();
  });

  it("still parses every pre-existing state value (regression guard)", () => {
    for (const state of ["not_started", "working", "idle", "done", "exited"] as const) {
      const msg = { type: "session:state", sessionId: "sess-4", state };
      expect(() => ServerMessage.parse(msg)).not.toThrow();
    }
  });
});

// 4b.T3 (plan 04, "Workspaces"): session:created gains `spawnedFrom` —
// present as a string, present as null, or absent entirely (pre-upgrade-
// daemon compat) must all parse.
describe("ws protocol — session:created accepts spawnedFrom (4b.T3)", () => {
  const base = {
    type: "session:created" as const,
    sessionId: "sess-1",
    worktreeId: "wt-1",
    sessionType: "agent",
  };

  it("parses with spawnedFrom as a session id string", () => {
    const msg = { ...base, spawnedFrom: "sess-source" };
    expect(() => ServerMessage.parse(msg)).not.toThrow();
    expect(ServerMessage.parse(msg)).toMatchObject({ spawnedFrom: "sess-source" });
  });

  it("parses with spawnedFrom: null (no source)", () => {
    const msg = { ...base, spawnedFrom: null };
    expect(() => ServerMessage.parse(msg)).not.toThrow();
    expect(ServerMessage.parse(msg)).toMatchObject({ spawnedFrom: null });
  });

  it("parses with spawnedFrom absent entirely (pre-upgrade daemon compat)", () => {
    expect(() => ServerMessage.parse(base)).not.toThrow();
  });
});
