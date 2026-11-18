import type { ApiInstance } from "@/api";
import type { DraftTextDoc } from "@/api/types";
import type { DraftBuffer } from "./buffer";
import { decideRemote, type ScopeState } from "./reconcile";

/** `ScopeState` is declared by the pure reconcile helpers (Phase 1); re-exported
 *  here so the engine's state has one import site. Never redeclare it. */
export type { ScopeState };

/** The slice of `ApiInstance` the draft-sync engine drives (narrowed so tests can fake it). */
export type DraftTextApi = Pick<ApiInstance, "listDraftTexts" | "getDraftText" | "putDraftText" | "on">;

/** A scope's shared engine state (Decision 9: one per scope per api, shared by
 *  every binding of that scope on this page). */
export interface ScopeRecord extends ScopeState {
  scope: string;
  /** Same-page bindings of this scope; a local save updates the others (Decision 9). */
  listeners: Set<(text: string) => void>;
  /** Whether the server doc has been fetched yet (Decision 7's first-paint order). */
  docLoaded: boolean;
  /** Which local store the first paint came from, when the server doc was unknown. */
  seed: "buffer" | "legacy" | null;
  /** Debounce timer for the next PUT (Decision 5). */
  timer: ReturnType<typeof setTimeout> | null;
  /** Text waiting on that timer. */
  scheduled: string | null;
  /** Latest text waiting for the in-flight PUT to finish (one PUT per scope). */
  queued: string | null;
  queuedKeepalive: boolean;
  inflight: Promise<void> | null;
  /** Text the daemon rejected with 413; never retried unchanged (R7). */
  rejectedText: string | null;
  /** One-shot retry timer after a retryable PUT failure; at most one per scope. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Consecutive retryable failures, for the capped backoff; reset on success. */
  retryAttempt: number;
}

/**
 * Decision 7's first paint: buffer (when its base revision matches the loaded
 * doc, or no doc is loaded yet) → loaded doc → legacy key → "".
 */
export function resolveInitialText(
  doc: DraftTextDoc | null,
  buffer: DraftBuffer | null,
  legacy: string,
): { text: string; seed: "buffer" | "legacy" | null } {
  if (doc) {
    if (buffer && buffer.baseRevision === doc.revision) return { text: buffer.text, seed: "buffer" };
    return { text: doc.text, seed: null };
  }
  if (buffer) return { text: buffer.text, seed: "buffer" };
  if (legacy !== "") return { text: legacy, seed: "legacy" };
  return { text: "", seed: null };
}

/**
 * Build a scope's record. With no server doc yet, the seeded text is treated as
 * already synced (`lastSynced === localText`) so the doc that arrives with the
 * first fetch can win — a stale legacy draft must not overwrite the server.
 */
export function createRecord(
  scope: string,
  ownClientId: string,
  doc: DraftTextDoc | null,
  buffer: DraftBuffer | null,
  legacy: string,
): ScopeRecord {
  const { text, seed } = resolveInitialText(doc, buffer, legacy);
  return {
    scope,
    localText: text,
    lastSynced: doc ? doc.text : text,
    heldRevision: doc ? doc.revision : 0,
    pendingRemote: null,
    ownClientId,
    listeners: new Set(),
    docLoaded: doc !== null,
    seed,
    timer: null,
    scheduled: null,
    queued: null,
    queuedKeepalive: false,
    inflight: null,
    rejectedText: null,
    retryTimer: null,
    retryAttempt: 0,
  };
}

/** What one fetched doc means for a bound scope. */
export type DocArrival =
  /** Already held (stale revision, or our own write) — nothing to do. */
  | { kind: "none" }
  /** First doc for an unchanged editor: adopt it silently. */
  | { kind: "adopt"; revision: number; lastSynced: string }
  /** Server row is empty and the first paint came from the legacy key: keep it. */
  | { kind: "keepLocal"; revision: number }
  /** The stored buffer equals the doc: drop it. */
  | { kind: "clearBuffer"; revision: number; lastSynced: string }
  /** The stored buffer sits on exactly this revision: it is newer, PUT it. */
  | { kind: "flushBuffer"; text: string; serverText: string; revision: number }
  | { kind: "apply"; text: string; revision: number }
  | { kind: "pend"; text: string; revision: number };

/**
 * Decision 6 + Decision 4 for one fetched doc: a buffer based on exactly the
 * doc's revision is our unflushed edit and wins; a buffer on another revision is
 * stale and the server wins; a later refetch is just another remote event.
 */
export function planDocArrival(
  rec: Pick<ScopeState, "localText" | "lastSynced" | "heldRevision" | "ownClientId"> & {
    docLoaded: boolean;
    seed: ScopeRecord["seed"];
  },
  doc: DraftTextDoc,
  buffer: DraftBuffer | null,
): DocArrival {
  if (buffer && buffer.baseRevision === doc.revision) {
    return buffer.text === doc.text
      ? { kind: "clearBuffer", revision: doc.revision, lastSynced: doc.text }
      : { kind: "flushBuffer", text: buffer.text, serverText: doc.text, revision: doc.revision };
  }

  if (!rec.docLoaded) {
    // Typed before the first doc arrived: a dirty editor keeps its text and the
    // doc pends (Decision 4), exactly as for any later refetch.
    if (rec.localText !== rec.lastSynced) {
      return { kind: "pend", text: doc.text, revision: doc.revision };
    }
    // First doc for a record seeded from local storage (Decision 7).
    if (rec.seed === "legacy" && doc.text === "" && rec.localText !== "") {
      return { kind: "keepLocal", revision: doc.revision };
    }
    // The server wins over a stale local seed, and over an unchanged editor.
    if (doc.text !== rec.lastSynced || rec.seed !== null) {
      return { kind: "apply", text: doc.text, revision: doc.revision };
    }
    return { kind: "adopt", revision: doc.revision, lastSynced: doc.text };
  }

  const decision = decideRemote(rec, doc);
  if (decision === "ignore") return { kind: "none" };
  return decision === "apply"
    ? { kind: "apply", text: doc.text, revision: doc.revision }
    : { kind: "pend", text: doc.text, revision: doc.revision };
}

/** What folding one fetched doc needs from the engine besides the record itself. */
export interface DocFoldDeps {
  /** Drop a scope's stored buffer (stale, or consumed by a flush). */
  clearBuffer(scope: string): void;
  /** Queue a text immediately (a flushed buffer). */
  put(rec: ScopeRecord, text: string): void;
  /** Flush the editor's current text (Decision 6: a mounted dirty editor wins). */
  flush(rec: ScopeRecord): void;
  /** Set the text everywhere before notifying, so an applied remote never re-PUTs. */
  applyRemote(rec: ScopeRecord, text: string): void;
}

/**
 * Fold one fetched doc into a bound scope (`planDocArrival`, Decision 6 + 4).
 * The state mutation lives here; the buffer, listener and outbox effects are
 * injected, so the engine keeps no fold logic of its own.
 */
export function foldDocArrival(
  rec: ScopeRecord,
  doc: DraftTextDoc,
  buffer: DraftBuffer | null,
  deps: DocFoldDeps,
): void {
  const plan = planDocArrival(rec, doc, buffer);
  if (plan.kind === "none") {
    // A failed write with no server change and no buffer (storage unavailable):
    // the mounted editor still owns its text.
    if (rec.listeners.size > 0 && rec.localText !== rec.lastSynced) deps.flush(rec);
    return;
  }
  // A buffer on another revision is stale: the server moved on (Decision 6).
  if (buffer && plan.kind !== "flushBuffer") deps.clearBuffer(doc.scope);
  rec.docLoaded = true;
  rec.heldRevision = Math.max(rec.heldRevision, plan.revision);

  switch (plan.kind) {
    case "flushBuffer":
      rec.localText = plan.text;
      rec.lastSynced = plan.serverText;
      rec.heldRevision = plan.revision;
      rec.seed = null;
      for (const listener of rec.listeners) listener(plan.text);
      deps.put(rec, plan.text);
      return;
    case "apply":
      deps.applyRemote(rec, plan.text);
      return;
    case "pend":
      rec.pendingRemote = { text: plan.text, revision: plan.revision };
      // D6: a mounted dirty editor wins by flush order; an unbound one yields
      // to the server.
      if (rec.listeners.size > 0) deps.flush(rec);
      else {
        deps.applyRemote(rec, plan.text);
        deps.clearBuffer(doc.scope);
      }
      return;
    default:
      rec.lastSynced = plan.kind === "keepLocal" ? "" : plan.lastSynced;
  }
}

