import { ApiError } from "@/api/errors";
import type { DraftTextDoc } from "@/api/types";
import { clearBuffer, readBuffer, writeBuffer } from "./buffer";
import { DRAFT_TEXT_DEBOUNCE_MS, KEEPALIVE_MAX_BYTES, RETRY_BASE_MS, RETRY_MAX_MS } from "./constants";
import { onOwnAck } from "./reconcile";
import type { DraftTextApi, ScopeRecord } from "./scopeState";

/** UTF-8 byte length — the cap and the keepalive gate count bytes, not chars. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Worth another attempt: network/unknown failures, or 5xx / 408 / 429. A 4xx
 *  (400 bad scope/id, 404 scope gone, 413 too large) is final. */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status >= 500 || err.status === 408 || err.status === 429;
}

export interface OutboxDeps {
  api: DraftTextApi;
  ownClientId: string;
  /** Set the text everywhere before notifying, so an applied remote never re-PUTs. */
  applyRemote(rec: ScopeRecord, text: string): void;
  /** Keep the engine's server-doc cache current after a successful write. */
  onDoc(doc: DraftTextDoc): void;
}

/**
 * One scope's client → server direction: the 600 ms debounce (Decision 5), the
 * offline buffer written on every scheduled save (Decision 6), one PUT in flight
 * per scope coalescing the latest text, the own-ack fold (Decision 4), and the
 * capped per-scope retry after a failed write (Decision 6's other half).
 */
export class ScopeOutbox {
  /** Terminal once the engine stops: no timer may be armed after it. */
  private stopped = false;

  constructor(private readonly deps: OutboxDeps) {}

  /** Debounced save. A text the server already holds drops the timer/buffer. */
  save(rec: ScopeRecord, text: string): void {
    if (text === rec.lastSynced) {
      // Already on the server — but still queue a PUT if one for other text is
      // on its way (the user typed forward and back to the synced text).
      this.cancel(rec);
      const buffer = readBuffer(rec.scope);
      if (buffer && buffer.text === text) clearBuffer(rec.scope);
      this.enqueue(rec, text);
      return;
    }
    writeBuffer(rec.scope, text, rec.heldRevision);
    this.cancel(rec);
    rec.scheduled = text;
    rec.timer = setTimeout(() => {
      rec.timer = null;
      const scheduled = rec.scheduled;
      rec.scheduled = null;
      if (scheduled !== null) this.enqueue(rec, scheduled);
    }, DRAFT_TEXT_DEBOUNCE_MS);
  }

  /** PUT now (blur / send / unmount / pagehide). */
  flush(rec: ScopeRecord, opts?: { keepalive?: boolean }): void {
    this.cancel(rec);
    if (rec.localText !== rec.lastSynced) writeBuffer(rec.scope, rec.localText, rec.heldRevision);
    this.enqueue(rec, rec.localText, opts);
  }

  /** Queue a text immediately (clear, legacy import, a flushed buffer). */
  put(rec: ScopeRecord, text: string, opts?: { keepalive?: boolean }): void {
    this.enqueue(rec, text, opts);
  }

  /** Drop the debounce timer only; a pending retry is separate (see `cancelRetry`). */
  cancel(rec: ScopeRecord): void {
    if (rec.timer !== null) {
      clearTimeout(rec.timer);
      rec.timer = null;
    }
    rec.scheduled = null;
  }

  /** Drop a scope's pending retry timer (engine stop, or a superseding enqueue). */
  cancelRetry(rec: ScopeRecord): void {
    if (rec.retryTimer !== null) {
      clearTimeout(rec.retryTimer);
      rec.retryTimer = null;
    }
  }

  /** A remote text was applied: no older local text may still be sent. */
  discardUnsent(rec: ScopeRecord): void {
    this.cancel(rec);
    this.cancelRetry(rec);
    rec.queued = null;
    rec.queuedKeepalive = false;
  }

  /** Terminal: stop clears every timer and later retries arm none (engine stop). */
  stop(records: Iterable<ScopeRecord>): void {
    this.stopped = true;
    for (const rec of records) {
      this.cancel(rec);
      this.cancelRetry(rec);
    }
  }

  /** `window` `online`: retry every scope whose write is waiting on a timer, now. */
  retryNow(records: Iterable<ScopeRecord>): void {
    for (const rec of records) {
      if (rec.retryTimer === null) continue;
      this.cancelRetry(rec);
      if (rec.localText !== rec.lastSynced && rec.localText !== rec.rejectedText) {
        this.enqueue(rec, rec.localText);
      }
    }
  }

  /** Decision 5: buffer synchronously, keepalive-PUT only when the body fits. */
  pageHide(records: Iterable<ScopeRecord>): void {
    for (const rec of records) {
      if (rec.localText === rec.lastSynced) continue;
      this.cancel(rec);
      writeBuffer(rec.scope, rec.localText, rec.heldRevision);
      if (byteLength(rec.localText) < KEEPALIVE_MAX_BYTES) {
        this.enqueue(rec, rec.localText, { keepalive: true });
      }
    }
  }

  private enqueue(rec: ScopeRecord, text: string, opts?: { keepalive?: boolean }): void {
    // A gone scope (final 400/404 or a deleted session) is never written again.
    if (rec.gone) return;
    // A new write supersedes a scheduled retry; only a success resets `attempt`.
    this.cancelRetry(rec);
    rec.queued = text;
    rec.queuedKeepalive = opts?.keepalive === true;
    if (rec.inflight) return;
    this.kick(rec);
  }

  /** One-shot retry after a retryable failure: 1 s, 2 s, 4 s … capped at 30 s. */
  private scheduleRetry(rec: ScopeRecord): void {
    if (this.stopped) return; // stopped: an in-flight failure must not re-arm anything.
    rec.retryAttempt += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (rec.retryAttempt - 1), RETRY_MAX_MS);
    this.cancelRetry(rec);
    rec.retryTimer = setTimeout(() => {
      rec.retryTimer = null;
      // Send the latest text, never the one that failed if it has moved on.
      if (rec.localText !== rec.lastSynced && rec.localText !== rec.rejectedText) {
        this.enqueue(rec, rec.localText);
      }
    }, delay);
  }

  private kick(rec: ScopeRecord): void {
    // `pump` may finish synchronously (a coalesced no-op), so clear the guard in
    // a microtask rather than from inside it. A write landing after that loop
    // ended (e.g. a send clear right after a blur flush's no-op) sees `inflight`
    // still set and parks in `queued`; re-kick it once the guard is released.
    rec.inflight = this.pump(rec).finally(() => {
      rec.inflight = null;
      if (rec.queued !== null) this.kick(rec);
    });
  }

  private async pump(rec: ScopeRecord): Promise<void> {
    while (rec.queued !== null) {
      if (rec.gone) {
        rec.queued = null;
        break;
      }
      const text = rec.queued;
      const keepalive = rec.queuedKeepalive;
      rec.queued = null;
      rec.queuedKeepalive = false;
      if (text === rec.lastSynced || text === rec.rejectedText) continue;
      try {
        const doc = await this.deps.api.putDraftText(
          rec.scope,
          text,
          this.deps.ownClientId,
          keepalive ? { keepalive: true } : undefined,
        );
        rec.rejectedText = null;
        rec.retryAttempt = 0;
        this.cancelRetry(rec);
        this.deps.onDoc(doc);
        this.applyOwnAck(rec, text, doc);
      } catch (err) {
        // 413: keep the local text, never retry this exact one (R7). A retryable
        // failure (network, 5xx, 408, 429) arms one capped retry per scope, since
        // a socket that stays open will never send a `ws:open` flush.
        if (err instanceof ApiError && err.status === 413) {
          rec.rejectedText = text;
        } else if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
          // A final rejection means the scope is gone (deleted session, unknown
          // id): drop the buffer and never write this scope again, so a
          // reconnect cannot re-PUT it forever (F-04).
          clearBuffer(rec.scope);
          rec.lastSynced = rec.localText; // nothing left to flush/pagehide-send.
          rec.gone = true;
          rec.queued = null;
          this.cancelRetry(rec);
        } else if (isRetryable(err) && rec.queued === null) {
          this.scheduleRetry(rec);
        }
      }
    }
  }

  private applyOwnAck(rec: ScopeRecord, sent: string, doc: DraftTextDoc): void {
    const { applyPending } = onOwnAck(rec, sent, doc.revision);
    const buffer = readBuffer(rec.scope);
    if (buffer && buffer.text === sent) clearBuffer(rec.scope);
    if (applyPending !== null) this.deps.applyRemote(rec, applyPending);
  }
}
