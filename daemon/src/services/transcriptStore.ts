/**
 * TranscriptStore — the storage port for a session's chat transcript (R0.1).
 *
 * All transcript access goes through this port; no caller touches the underlying
 * file/DB directly. The first concrete impl is SQLite (`sqliteTranscriptStore.ts`);
 * the interface is intentionally kept Postgres-admissible (durable monotonic
 * `logSeq`, bounded/keyset reads) so a future impl needs no caller changes.
 */

import type { NormalizedEvent, UsageInfo } from "../types.js";

/** Last model + last real-usage summary, for the status-bar meta rebuild. */
export interface TranscriptMeta {
  model?: string;
  usage?: UsageInfo;
}

/**
 * A bounded window of transcript events plus the keyset cursor a client needs to
 * page further back (R2.1/R2.2). `oldestSeq` is the `logSeq` of the first event
 * in `events` (undefined when the window is empty); `hasMore` is true when older
 * rows exist before it.
 */
export interface TranscriptPage {
  events: NormalizedEvent[];
  oldestSeq?: number;
  hasMore: boolean;
}

/** The native cursor watermark persisted for a session (R0.5). */
export interface NativeWatermark {
  cli: string;
  cursor: string;
}

/** Outcome of a native-history import pass (observability, N5). */
export interface ImportOutcome {
  /** Events actually appended (dedup-skipped turns excluded). */
  imported: number;
  /** Turns appended. */
  turnsImported: number;
  /** Turns skipped because they were already mirrored (round-trip dedup, J5). */
  turnsSkipped: number;
  /** The native cursor watermark persisted by this pass. */
  cursor: string;
}

export interface TranscriptStore {
  /**
   * Append one event and return the durable monotonic `logSeq` assigned to it.
   * The `logSeq` is set on the passed event too (so the caller can broadcast it).
   */
  append(ev: NormalizedEvent): number;
  /** Full transcript in insertion (`logSeq`) order. Migration + P0 full replay. */
  readAll(): NormalizedEvent[];
  /** Last `nTurns` turns, turn-aligned (P1 — never splits a turn) + a cursor. */
  tail(nTurns: number): TranscriptPage;
  /** Keyset page of events strictly before `seq`, turn-aligned + a cursor (P1). */
  pageBefore(seq: number, limit: number): TranscriptPage;
  /** Events strictly newer than `seq` — the reconnect delta (P1). */
  since(seq: number): NormalizedEvent[];
  /**
   * Mark every row at/after `seq` superseded (edit-a-sent-message fork, R3.4).
   * Append-only: the old branch is kept but hidden from all reads. Returns the
   * distinct `turnId`s flagged (for the fork broadcast / re-sync, R3.6).
   */
  markSupersededFrom(seq: number): string[];
  /** First (live) `logSeq` of a turn — the fork cut point (R3.4); undefined if absent. */
  firstSeqOfTurn(turnId: string): number | undefined;
  /** Number of persisted events for this session. */
  count(): number;
  /** Last model + last real usage, for status-bar meta rebuild (bounded in P1). */
  lastMeta(): TranscriptMeta;
  /**
   * Import native-history events in a SINGLE transaction (R0.9). Assigns
   * `logSeq` continuing from `MAX(seq)+1`; DEDUPS any turn already mirrored (by
   * `turnId` or by the user prompt's content — a JSON→tty→JSON round trip must
   * not double-import); persists the `cursor` watermark. On any failure it rolls
   * back, leaving both the rows AND the watermark unchanged (J14).
   */
  importTransaction(events: NormalizedEvent[], opts: { cli: string; cursor: string }): ImportOutcome;
  /** The persisted native cursor watermark for this session, if any (R0.5). */
  getNativeWatermark(): NativeWatermark | undefined;
  /** Release the underlying handle. */
  close(): void;
}
