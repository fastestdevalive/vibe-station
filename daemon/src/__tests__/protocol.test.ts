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
