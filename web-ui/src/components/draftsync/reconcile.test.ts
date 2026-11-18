import { describe, expect, it } from "vitest";
import { decideRemote, onOwnAck, type ScopeState } from "./reconcile";

const OWN = "client-a";

/** A clean scope holding `text` at revision `held`. */
function state(patch: Partial<ScopeState> = {}): ScopeState {
  return {
    localText: "",
    lastSynced: "",
    heldRevision: 0,
    pendingRemote: null,
    ownClientId: OWN,
    ...patch,
  };
}

describe("decideRemote", () => {
  it("ignores_own_client_id", () => {
    expect(decideRemote(state({ localText: "mine", lastSynced: "mine" }), { revision: 9, clientId: OWN })).toBe("ignore");
    // Even while dirty: our own echo never reaches the editor.
    expect(decideRemote(state({ localText: "typing", lastSynced: "mine" }), { revision: 9, clientId: OWN })).toBe("ignore");
  });

  it("ignores_stale_revision", () => {
    const s = state({ heldRevision: 5 });
    expect(decideRemote(s, { revision: 5, clientId: "other" })).toBe("ignore");
    expect(decideRemote(s, { revision: 4, clientId: "other" })).toBe("ignore");
  });

  it("applies_when_clean", () => {
    const s = state({ localText: "mine", lastSynced: "mine", heldRevision: 2 });
    expect(decideRemote(s, { revision: 3, clientId: "other" })).toBe("apply");
    // An event with no client id cannot be ours.
    expect(decideRemote(s, { revision: 4, clientId: null })).toBe("apply");
  });

  it("pends_when_dirty", () => {
    const s = state({ localText: "typing", lastSynced: "mine", heldRevision: 2 });
    expect(decideRemote(s, { revision: 3, clientId: "other" })).toBe("pend");
  });
});

describe("onOwnAck", () => {
  it("own_ack_drops_pending_when_pending_rev_le_R", () => {
    const s = state({ localText: "typed", lastSynced: "old", pendingRemote: { text: "remote", revision: 4 } });
    expect(onOwnAck(s, "typed", 5)).toEqual({ applyPending: null });
    expect(s.pendingRemote).toBeNull();
    expect(s.heldRevision).toBe(5);
    expect(s.lastSynced).toBe("typed");
    // Dirty until the next keystroke settles — the pending text was superseded.
    expect(s.localText).toBe("typed");
  });

  it("own_ack_applies_pending_when_newer_and_local_unchanged", () => {
    const s = state({
      localText: "typed",
      lastSynced: "typed",
      heldRevision: 7,
      pendingRemote: { text: "remote", revision: 7 },
    });
    expect(onOwnAck(s, "typed", 5)).toEqual({ applyPending: "remote" });
    expect(s.pendingRemote).toBeNull();
    expect(s.heldRevision).toBe(7);
  });

  it("late_own_ack_does_not_drop_newer_remote", () => {
    // Our PUT (revision 4) was in flight when a newer remote (9) landed.
    const s = state({
      localText: "typed",
      lastSynced: "typed",
      heldRevision: 9,
      pendingRemote: { text: "remote", revision: 9 },
    });
    expect(onOwnAck(s, "typed", 4)).toEqual({ applyPending: "remote" });
    expect(s.pendingRemote).toBeNull();
    expect(s.heldRevision).toBe(9);
  });

  it("own_ack_keeps_pending_when_local_changed", () => {
    const s = state({
      localText: "typed more",
      lastSynced: "typed",
      pendingRemote: { text: "remote", revision: 7 },
    });
    expect(onOwnAck(s, "typed", 5)).toEqual({ applyPending: null });
    expect(s.pendingRemote).toEqual({ text: "remote", revision: 7 });
    expect(s.lastSynced).toBe("typed");
  });
});
