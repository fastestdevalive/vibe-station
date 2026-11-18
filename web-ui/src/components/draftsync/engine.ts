import type { ApiInstance } from "@/api";
import type { DraftTextDoc, WSEvent } from "@/api/types";
import { bufferedScopes, clearBuffer, readBuffer, writeBuffer } from "./buffer";
import { getClientId } from "./clientId";
import { startGlobalDraftMirror } from "./globalDraftMirror";
import { legacyTextFor, migrateLegacy, type LegacyImportTarget } from "./migrateLegacy";
import { ScopeOutbox } from "./outbox";
import { decideRemote } from "./reconcile";
import {
  createRecord,
  foldDocArrival,
  resolveInitialText,
  type DocFoldDeps,
  type DraftTextApi,
  type ScopeRecord,
} from "./scopeState";

/** What `useDraftText` hands an editor (Decision 9). */
export interface DraftBinding {
  /** The first paint's text (buffer → server doc → legacy → ""). */
  initialText: string;
  save(text: string): void;
  flush(opts?: { keepalive?: boolean }): void;
  clear(): void;
  dispose(): void;
}

type ChangedEvent = Extract<WSEvent, { type: "draft-text:changed" }>;

const engines = new WeakMap<object, DraftTextEngine>();

/** The one engine per api instance, if `ensureDraftTextSync` has run (Decision 9). */
export function engineFor(api: ApiInstance): DraftTextEngine | undefined {
  return engines.get(api as unknown as object);
}

/** Create (once) the page's draft-sync engine: subscribe the WS event, fetch
 *  once now, and refetch on `ws:open` / `ws:resync` (Decision 9). */
export function ensureDraftTextSync(api: ApiInstance): void {
  const key = api as unknown as object;
  if (engines.has(key)) return;
  const engine = new DraftTextEngine(api as DraftTextApi);
  engines.set(key, engine);
  engine.start();
}

/** Append to a scope's draft with no editor mounted (Decision 9). Inert without
 *  an engine — a test that never ensures one keeps the legacy localStorage path. */
export function appendDraftText(api: ApiInstance, scope: string, text: string): void {
  engineFor(api)?.append(scope, text);
}

/**
 * The client draft-sync owner: one per api instance. Holds every scope's shared
 * state, the server-doc cache and the one-time legacy import. The per-scope write
 * queue lives in `outbox.ts` (`ScopeOutbox`), the Decision 4 folding in
 * `reconcile.ts`.
 */
export class DraftTextEngine implements LegacyImportTarget {
  /** Raw Tier-2 prompt read synchronously at creation, before anything can
   *  rewrite the persisted store (Decision 7). */
  readonly globalPromptSnapshot: string | null;

  private readonly records = new Map<string, ScopeRecord>();
  private readonly docs = new Map<string, DraftTextDoc>();
  private readonly ownClientId: string;
  private readonly outbox: ScopeOutbox;
  /** The buffer/listener/outbox effects `foldDocArrival` drives. */
  private readonly foldDeps: DocFoldDeps = {
    clearBuffer,
    put: (rec, text) => this.outbox.put(rec, text),
    flush: (rec) => this.outbox.flush(rec),
    applyRemote: (rec, text) => this.applyRemote(rec, text),
  };
  private readonly offs: Array<() => void> = [];
  private fetching: Promise<void> | null = null;
  /** Whether the first successful bulk fetch has returned: from then on a scope
   *  missing from the list is a KNOWN revision-0 empty doc, not an unknown one. */
  private listed = false;
  private migrated = false;
  /** The `global-new` mirror's teardown (Decision 10). */
  private mirrorStop: (() => void) | null = null;

  constructor(
    private readonly api: DraftTextApi,
    clientId: string = getClientId(),
  ) {
    this.ownClientId = clientId;
    this.globalPromptSnapshot = legacyTextFor("global-new") || null;
    this.outbox = new ScopeOutbox({
      api,
      ownClientId: clientId,
      applyRemote: (rec, text) => this.applyRemote(rec, text),
      onDoc: (doc) => this.docs.set(doc.scope, doc),
    });
  }

  /** Wire the WS subscriptions, the pagehide flush and the initial fetch. */
  start(): void {
    this.offs.push(
      this.api.on("draft-text:changed", (ev) => {
        if (ev.type === "draft-text:changed") this.onChanged(ev);
      }),
    );
    const refetch = () => void this.fetch();
    this.offs.push(this.api.on("ws:open", refetch));
    this.offs.push(this.api.on("ws:resync", refetch));
    if (typeof window !== "undefined") {
      const onPageHide = () => this.outbox.pageHide(this.records.values());
      const onOnline = () => this.outbox.retryNow(this.records.values());
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("online", onOnline);
      this.offs.push(() => window.removeEventListener("pagehide", onPageHide));
      this.offs.push(() => window.removeEventListener("online", onOnline));
    }
    // Decision 10: the sidebar's Tier-2 draft mirrors this scope both ways.
    this.mirrorStop = startGlobalDraftMirror(this);
    void this.fetch();
  }

  stop(): void {
    this.mirrorStop?.();
    this.mirrorStop = null;
    for (const off of this.offs.splice(0)) off();
    this.outbox.stop(this.records.values());
  }

  // ── Bindings ────────────────────────────────────────────────────────────────

  /** The first paint (Decision 7), read without creating the record: safe to call
   *  during render (the effect's `bind` resolves the same value). */
  initialText(scope: string): string {
    const rec = this.records.get(scope);
    if (rec) return rec.localText;
    return resolveInitialText(this.knownDoc(scope), readBuffer(scope), legacyTextFor(scope)).text;
  }

  bind(scope: string, onRemote: (text: string) => void): DraftBinding {
    const rec = this.ensureRecord(scope);
    rec.listeners.add(onRemote);
    return {
      initialText: rec.localText,
      save: (text) => this.save(scope, text, onRemote),
      flush: (opts) => this.outbox.flush(rec, opts),
      clear: () => this.clear(scope),
      dispose: () => {
        rec.listeners.delete(onRemote);
        this.outbox.flush(rec);
      },
    };
  }

  /** Debounced save; a local edit also updates same-page sibling bindings. */
  save(scope: string, text: string, caller?: (text: string) => void): void {
    const rec = this.ensureRecord(scope);
    if (text === rec.rejectedText) return; // 413: this exact text is never retried.
    rec.localText = text;
    rec.seed = null;
    for (const listener of rec.listeners) if (listener !== caller) listener(text);
    this.outbox.save(rec, text);
  }

  /** Send path: clear everywhere and PUT "" (Decision 5). */
  clear(scope: string): void {
    const rec = this.records.get(scope);
    if (!rec) return;
    this.outbox.cancel(rec);
    rec.localText = "";
    rec.seed = null;
    rec.pendingRemote = null;
    rec.rejectedText = null;
    for (const listener of rec.listeners) listener("");
    clearBuffer(scope);
    this.outbox.put(rec, "");
  }

  /** One-time legacy import (Decision 7): show the text on bound editors and PUT it. */
  importLocal(scope: string, text: string): void {
    if (text === "") return;
    const rec = this.ensureRecord(scope);
    if (rec.localText !== "" && rec.localText !== text) return; // typed/buffered text already wins
    // `migrateLegacy` only imports into an empty row, so this IS what the server
    // holds: recording it makes the import a real dirty write (and one PUT).
    rec.lastSynced = this.serverText(scope);
    rec.docLoaded = true;
    rec.localText = text;
    rec.seed = null;
    for (const listener of rec.listeners) listener(text);
    writeBuffer(scope, text, rec.heldRevision);
    this.outbox.put(rec, text);
  }

  /** Append to a scope's draft with no editor mounted (new line unless empty). */
  append(scope: string, text: string): void {
    if (text.trim() === "") return;
    const rec = this.ensureRecord(scope);
    this.save(scope, rec.localText.trim().length > 0 ? `${rec.localText}\n${text}` : text);
  }

  // ── Server → client ─────────────────────────────────────────────────────────

  /** The server's text for a scope ("" for an absent row), for `migrateLegacy`. */
  serverText(scope: string): string {
    return this.docs.get(scope)?.text ?? "";
  }

  private onChanged(ev: ChangedEvent): void {
    const doc: DraftTextDoc = {
      scope: ev.scope,
      text: ev.text,
      revision: ev.revision,
      updatedAt: ev.updatedAt,
      clientId: ev.clientId,
    };
    this.docs.set(ev.scope, doc);
    const rec = this.records.get(ev.scope);
    if (!rec) return;
    const decision = decideRemote(rec, ev);
    if (decision === "ignore") return;
    rec.heldRevision = ev.revision;
    if (decision === "apply") this.applyRemote(rec, ev.text);
    else rec.pendingRemote = { text: ev.text, revision: ev.revision };
  }

  /** Set the text everywhere BEFORE notifying, so an apply never re-PUTs (Decision 4). */
  private applyRemote(rec: ScopeRecord, text: string): void {
    this.outbox.discardUnsent(rec); // nothing older than the applied remote may still be sent.
    rec.localText = text;
    rec.lastSynced = text;
    rec.pendingRemote = null;
    rec.seed = null;
    for (const listener of rec.listeners) listener(text);
  }

  private fetch(): Promise<void> {
    if (this.fetching) return this.fetching;
    const run = (async () => {
      try {
        const drafts = await this.api.listDraftTexts();
        this.listed = true;
        const seen = new Set<string>();
        for (const doc of drafts) {
          seen.add(doc.scope);
          this.absorbDoc(doc);
        }
        // A bound scope absent from the list is revision 0 — its buffer may still
        // match that base and must be flushed (Decision 6).
        for (const rec of this.records.values()) {
          if (!seen.has(rec.scope)) this.absorbDoc(this.emptyDoc(rec.scope));
        }
        // A buffer can outlive its editor: flush or drop it with no binding mounted.
        for (const scope of bufferedScopes()) {
          if (this.records.has(scope)) continue;
          this.ensureRecord(scope);
          this.absorbDoc(this.docs.get(scope) ?? this.emptyDoc(scope));
        }
        if (!this.migrated) {
          this.migrated = true;
          migrateLegacy(this);
        }
      } catch {
        // Offline: buffers stay; the next ws:open / ws:resync retries.
      } finally {
        this.fetching = null;
      }
    })();
    this.fetching = run;
    return run;
  }

  private emptyDoc(scope: string): DraftTextDoc {
    return { scope, text: "", revision: 0, updatedAt: null, clientId: null };
  }

  /** The server doc for a scope: once the list has returned, a missing scope is
   *  a known revision-0 empty doc rather than an unknown one. */
  private knownDoc(scope: string): DraftTextDoc | null {
    return this.docs.get(scope) ?? (this.listed ? this.emptyDoc(scope) : null);
  }

  /** Fold one fetched doc into a bound scope (`foldDocArrival`, Decision 6 + 4). */
  private absorbDoc(doc: DraftTextDoc): void {
    this.docs.set(doc.scope, doc);
    const rec = this.records.get(doc.scope);
    if (rec) foldDocArrival(rec, doc, readBuffer(doc.scope), this.foldDeps);
  }

  private ensureRecord(scope: string): ScopeRecord {
    const existing = this.records.get(scope);
    if (existing) return existing;
    const doc = this.knownDoc(scope);
    const buffer = readBuffer(scope);
    const rec = createRecord(scope, this.ownClientId, doc, buffer, legacyTextFor(scope));
    this.records.set(scope, rec);
    if (doc && buffer) {
      if (buffer.baseRevision !== doc.revision || buffer.text === doc.text) clearBuffer(scope);
      else this.outbox.put(rec, buffer.text);
    }
    return rec;
  }
}
