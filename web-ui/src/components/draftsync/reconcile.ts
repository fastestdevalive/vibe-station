/** One scope's draft-sync state (shared by every binding on that scope, Decision 9). */
export interface ScopeState {
  /** What the editor holds right now. */
  localText: string;
  /** The text the server is known to hold (our last ack / the last applied remote). */
  lastSynced: string;
  /** Highest server revision this client has seen (own ack or remote event). */
  heldRevision: number;
  /** A remote update that arrived while the editor was dirty (Decision 4). */
  pendingRemote: { text: string; revision: number } | null;
  ownClientId: string;
}

export type RemoteDecision = "ignore" | "apply" | "pend";

/**
 * Decision 4: classify a `draft-text:changed` event. Pure — the caller applies
 * the text (setting `localText = lastSynced = text` before `onRemote`) or stores
 * `pendingRemote`, and sets `heldRevision = ev.revision` in both cases.
 */
export function decideRemote(
  s: Pick<ScopeState, "localText" | "lastSynced" | "heldRevision" | "ownClientId">,
  ev: { revision: number; clientId: string | null },
): RemoteDecision {
  // The echo of our own PUT: our HTTP reply already carries it (and may arrive later).
  if (ev.clientId !== null && ev.clientId === s.ownClientId) return "ignore";
  // Stale or already-held revision (replies and events may arrive in either order).
  if (ev.revision <= s.heldRevision) return "ignore";
  return s.localText === s.lastSynced ? "apply" : "pend";
}

/**
 * Decision 4: fold our own PUT reply (text `sent`, server `revision`) into the
 * scope state. Updates `heldRevision`/`lastSynced` and drops or keeps
 * `pendingRemote`; returns the pending text to apply now (already cleared from
 * `pendingRemote`), or null. Applying it is the caller's job: set
 * `localText = lastSynced = text` before calling `onRemote`.
 */
export function onOwnAck(s: ScopeState, sent: string, revision: number): { applyPending: string | null } {
  // Unchanged since that PUT — i.e. the user has not typed over `sent` since.
  const unchangedSinceSend = s.localText === sent;
  s.heldRevision = Math.max(s.heldRevision, revision);
  s.lastSynced = sent;

  const pending = s.pendingRemote;
  if (!pending) return { applyPending: null };
  // The remote text is not newer than what we just wrote: it is superseded.
  if (pending.revision <= revision) {
    s.pendingRemote = null;
    return { applyPending: null };
  }
  // A newer remote arrived while our PUT was in flight: apply it now that the
  // box still shows exactly what we sent (never discarding a newer remote).
  if (unchangedSinceSend) {
    s.pendingRemote = null;
    return { applyPending: pending.text };
  }
  // The user typed since the PUT; keep pending — our next ack (revision >
  // pending.revision) drops it.
  return { applyPending: null };
}
