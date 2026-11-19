import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import type { DraftTextDoc, WSEvent } from "@/api/types";
import { readBuffer, writeBuffer } from "./buffer";
import { DraftTextEngine, engineFor, ensureDraftTextSync } from "./engine";
import { LEGACY_MIGRATION_MARKER } from "./migrateLegacy";
import type { DraftTextApi, ScopeRecord } from "./scopeState";

type Handler = (ev: WSEvent) => void;

interface FakeServer {
  rows: Map<string, DraftTextDoc>;
  handlers: Map<string, Set<Handler>>;
  puts: Array<{ scope: string; text: string; clientId: string; keepalive: boolean }>;
  /** Thrown by every PUT while set. */
  fail: unknown;
  /** Hold PUT replies until `release()` (the write itself already landed). */
  hold: boolean;
  held: Array<{ doc: DraftTextDoc; resolve: (doc: DraftTextDoc) => void }>;
  /** Hold each PUT's server-side apply until `releaseApply()`: the request is in
   *  flight, so neither the row nor the docs cache has moved yet. */
  holdApply: boolean;
  heldApplies: Array<() => void>;
  /** Hold each PUT's rejection until `rejectHeld()`: it fails only after the test
   *  calls it (e.g. after `engine.stop()`). */
  holdReject: boolean;
  heldRejects: Array<{ reject: (err: unknown) => void }>;
}

function makeServer(): FakeServer {
  return {
    rows: new Map(),
    handlers: new Map(),
    puts: [],
    fail: null,
    hold: false,
    held: [],
    holdApply: false,
    heldApplies: [],
    holdReject: false,
    heldRejects: [],
  };
}

function emit(server: FakeServer, ev: WSEvent): void {
  for (const h of server.handlers.get("*") ?? []) h(ev);
  for (const h of server.handlers.get(ev.type) ?? []) h(ev);
}

/** The daemon's PUT semantics: unchanged text is a no-op, else revision+1 + event. */
function applyPut(server: FakeServer, scope: string, text: string, clientId: string): DraftTextDoc {
  const prev = server.rows.get(scope);
  if (prev && prev.text === text) return { ...prev };
  const row: DraftTextDoc = {
    scope,
    text,
    revision: (prev?.revision ?? 0) + 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    clientId,
  };
  server.rows.set(scope, row);
  emit(server, {
    type: "draft-text:changed",
    scope: row.scope,
    text: row.text,
    revision: row.revision,
    updatedAt: row.updatedAt ?? "",
    clientId: row.clientId,
  });
  return { ...row };
}

/** Another client's PUT: server state + event, in one call. */
function remotePut(server: FakeServer, scope: string, text: string, clientId: string): DraftTextDoc {
  return applyPut(server, scope, text, clientId);
}

function release(server: FakeServer): void {
  server.hold = false;
  for (const held of server.held.splice(0)) held.resolve(held.doc);
}

/** Apply every held PUT now (the in-flight request reaches the daemon). */
function releaseApply(server: FakeServer): void {
  server.holdApply = false;
  for (const apply of server.heldApplies.splice(0)) apply();
}

/** Reject every held PUT reply now (a write that fails only once in flight). */
function rejectHeld(server: FakeServer): void {
  server.holdReject = false;
  for (const held of server.heldRejects.splice(0)) held.reject(server.fail ?? new TypeError("network"));
}

function makeApi(server: FakeServer): DraftTextApi {
  return {
    async listDraftTexts() {
      return [...server.rows.values()].map((r) => ({ ...r }));
    },
    async getDraftText(scope) {
      const row = server.rows.get(scope);
      return row ? { ...row } : { scope, text: "", revision: 0, updatedAt: null, clientId: null };
    },
    putDraftText(scope, text, clientId, opts) {
      server.puts.push({ scope, text, clientId, keepalive: opts?.keepalive === true });
      if (server.holdReject) {
        return new Promise<DraftTextDoc>((_resolve, reject) => {
          server.heldRejects.push({ reject });
        });
      }
      if (server.holdApply) {
        return new Promise<DraftTextDoc>((resolve) => {
          server.heldApplies.push(() => resolve(applyPut(server, scope, text, clientId)));
        });
      }
      if (server.fail) return Promise.reject(server.fail);
      const doc = applyPut(server, scope, text, clientId);
      if (server.hold) {
        return new Promise<DraftTextDoc>((resolve) => {
          server.held.push({ doc, resolve });
        });
      }
      return Promise.resolve(doc);
    },
    on(type, handler) {
      if (!server.handlers.has(type)) server.handlers.set(type, new Set());
      server.handlers.get(type)!.add(handler as Handler);
      return () => server.handlers.get(type)?.delete(handler as Handler);
    },
  };
}

/** Flush microtasks + zero-delay timers. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

/** The engine's live record for a scope (the map is private; tests read one field). */
function pendingOf(engine: DraftTextEngine, scope: string): ScopeRecord["pendingRemote"] {
  const records = (engine as unknown as { records: Map<string, ScopeRecord> }).records;
  return records.get(scope)?.pendingRemote ?? null;
}

/** Engines started by a test; stopped afterwards so their pagehide listeners do
 *  not fire in a later test. */
const started: DraftTextEngine[] = [];

async function startEngine(server: FakeServer, clientId = "client-a"): Promise<DraftTextEngine> {
  const engine = new DraftTextEngine(makeApi(server), clientId);
  engine.start();
  started.push(engine);
  await settle();
  return engine;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const engine of started.splice(0)) engine.stop();
  vi.useRealTimers();
});

describe("DraftTextEngine — writes", () => {
  it("debounces_to_one_put", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    binding.save("a");
    binding.save("ab");
    await vi.advanceTimersByTimeAsync(300);
    expect(server.puts).toHaveLength(0);

    binding.save("abc");
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(server.puts.map((p) => p.text)).toEqual(["abc"]);
    expect(server.rows.get("s1")?.text).toBe("abc");
  });

  it("flush_on_dispose", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    binding.save("x");
    binding.dispose();
    await settle();

    expect(server.puts.map((p) => p.text)).toEqual(["x"]);
  });

  it("own_echo_ignored", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const remote = vi.fn();
    const binding = engine.bind("s1", remote);

    binding.save("mine");
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(server.rows.get("s1")?.text).toBe("mine");
    expect(remote).not.toHaveBeenCalled();
  });

  it("clear_puts_empty", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const remote = vi.fn();
    const binding = engine.bind("s1", remote);

    binding.save("x");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    binding.clear();
    await settle();

    expect(server.rows.get("s1")?.text).toBe("");
    expect(server.rows.get("s1")?.revision).toBe(2);
    expect(remote).toHaveBeenCalledWith("");
  });

  it("buffer_cleared_on_matching_ack", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    binding.save("x");
    expect(readBuffer("s1")?.text).toBe("x");
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(readBuffer("s1")).toBeNull();
  });

  it("save_same_text_notifies_no_listener_and_sends_no_put", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const sibling = vi.fn();
    engine.bind("s1", sibling);

    engine.save("s1", "same");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts.map((p) => p.text)).toEqual(["same"]);

    sibling.mockClear();
    engine.save("s1", "same");
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(server.puts).toHaveLength(1);
    expect(sibling).not.toHaveBeenCalled();
  });
});

describe("DraftTextEngine — remote updates", () => {
  it("remote_applies_when_clean", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const remote = vi.fn();
    engine.bind("s1", remote);

    emit(server, {
      type: "draft-text:changed",
      scope: "s1",
      text: "hi",
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });

    expect(remote).toHaveBeenCalledWith("hi");
    expect(engine.initialText("s1")).toBe("hi");
  });

  it("remote_apply_does_not_put", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    engine.bind("s1", () => {});

    emit(server, {
      type: "draft-text:changed",
      scope: "s1",
      text: "hi",
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(server.puts).toHaveLength(0);
  });

  it("remote_pends_when_dirty", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const remote = vi.fn();
    const binding = engine.bind("s1", remote);

    binding.save("mine");
    remotePut(server, "s1", "theirs", "client-b");
    expect(remote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    await settle();

    // Our PUT lands on revision 2, so the pending remote (revision 1) is dropped.
    expect(server.puts.map((p) => p.text)).toEqual(["mine"]);
    expect(server.rows.get("s1")?.revision).toBe(2);
    expect(remote).not.toHaveBeenCalled();
    expect(engine.initialText("s1")).toBe("mine");
  });

  it("late_own_ack_does_not_drop_newer_remote", async () => {
    const server = makeServer();
    server.rows.set("s1", {
      scope: "s1",
      text: "old",
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });
    const engine = await startEngine(server);
    const remote = vi.fn();
    const binding = engine.bind("s1", remote);
    expect(binding.initialText).toBe("old");

    server.hold = true;
    binding.save("mine");
    await vi.advanceTimersByTimeAsync(600);
    expect(server.held).toHaveLength(1);

    // A newer remote lands while our PUT's reply is still in flight (dirty -> pend).
    remotePut(server, "s1", "newer", "client-b");
    expect(remote).not.toHaveBeenCalled();

    release(server);
    await settle();

    // Our ack (rev 4) is older than the pending remote, and the box still shows
    // exactly what we sent — so the newer remote applies instead of being lost.
    expect(server.rows.get("s1")?.text).toBe("newer");
    expect(server.rows.get("s1")?.revision).toBe(5);
    expect(remote).toHaveBeenCalledWith("newer");
    expect(engine.initialText("s1")).toBe("newer");
  });

  it("two_clients_converge_last_write_wins", async () => {
    const server = makeServer();
    const engineA = await startEngine(server, "client-a");
    const engineB = await startEngine(server, "client-b");
    const remoteA = vi.fn();
    const remoteB = vi.fn();
    const a = engineA.bind("s1", remoteA);
    const b = engineB.bind("s1", remoteB);

    a.save("from-a");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(remoteB).toHaveBeenCalledWith("from-a");

    b.save("from-b");
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(remoteA).toHaveBeenCalledWith("from-b");
    expect(server.rows.get("s1")?.text).toBe("from-b");
    expect(engineA.initialText("s1")).toBe("from-b");
    expect(engineB.initialText("s1")).toBe("from-b");
  });

  it("sibling_bindings_same_scope_updated", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const first = vi.fn();
    const second = vi.fn();
    const b1 = engine.bind("s1", first);
    engine.bind("s1", second);

    b1.save("hi");

    expect(second).toHaveBeenCalledWith("hi");
    expect(first).not.toHaveBeenCalled();
  });

  it("ws_open_refetch_applies_missed_update", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const remote = vi.fn();
    engine.bind("s1", remote);

    // Written by another client while this one was offline: no event delivered.
    server.rows.set("s1", {
      scope: "s1",
      text: "missed",
      revision: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });
    emit(server, { type: "ws:open" });
    await settle();

    expect(remote).toHaveBeenCalledWith("missed");
  });

  it("ws_resync_refetch_applies_missed_update", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const remote = vi.fn();
    engine.bind("s1", remote);

    server.rows.set("s1", {
      scope: "s1",
      text: "missed",
      revision: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });
    emit(server, { type: "ws:resync" });
    await settle();

    expect(remote).toHaveBeenCalledWith("missed");
  });

  it("unbound_yield_drops_the_pending_debounce", async () => {
    const server = makeServer();
    const engine = await startEngine(server);

    // An unbound append arms the 600 ms debounce...
    engine.append("s2", "x");
    // ...and a refetch lands inside that window with a newer server row.
    server.rows.set("s2", {
      scope: "s2",
      text: "srv",
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });
    emit(server, { type: "ws:open" });
    await settle();

    // The record yielded locally, so its debounce must be dropped too: nothing
    // older than the applied remote may still leave this client.
    await vi.advanceTimersByTimeAsync(5000);
    await settle();

    expect(server.puts).toEqual([]);
    expect(server.rows.get("s2")?.text).toBe("srv");
    expect(engine.initialText("s2")).toBe("srv");
    expect(readBuffer("s2")).toBeNull();
  });

  it("remote_apply_on_clean_editor_cancels_stale_timer", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const remote = vi.fn();
    const binding = engine.bind("s1", remote);

    server.hold = true;
    binding.save("ab");
    await vi.advanceTimersByTimeAsync(600);
    expect(server.puts.map((p) => p.text)).toEqual(["ab"]);
    expect(server.held).toHaveLength(1);

    // Type forward and back: "ab" matches `lastSynced` again but the ack has not
    // arrived, so a debounce for "ab" is armed while the PUT is in flight.
    binding.save("abc");
    binding.save("ab");
    release(server);
    await settle();

    // The ack makes the record clean while that timer is still armed; a remote
    // text then applies.
    remotePut(server, "s1", "R", "client-b");
    await settle();
    await vi.advanceTimersByTimeAsync(2000);

    expect(server.puts.map((p) => p.text)).toEqual(["ab"]);
    expect(server.rows.get("s1")?.text).toBe("R");
    expect(remote).toHaveBeenLastCalledWith("R");
    expect(engine.initialText("s1")).toBe("R");
  });
});

describe("DraftTextEngine — offline buffer (Decision 6)", () => {
  it("put_failure_keeps_buffer_and_flushes_on_reconnect", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const remote = vi.fn();
    const binding = engine.bind("s1", remote);

    server.fail = new Error("offline");
    binding.save("offline-edit");
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(server.puts).toHaveLength(1);
    expect(server.rows.get("s1")).toBeUndefined();
    expect(readBuffer("s1")?.text).toBe("offline-edit");

    server.fail = null;
    emit(server, { type: "ws:open" });
    await settle();

    expect(server.rows.get("s1")?.text).toBe("offline-edit");
    expect(readBuffer("s1")).toBeNull();
    // Only the buffered text is re-announced, never a server value we dropped.
    expect(remote).toHaveBeenCalledWith("offline-edit");
  });

  it("buffer_with_stale_base_dropped", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    writeBuffer("s1", "local", 1);
    const remote = vi.fn();
    const binding = engine.bind("s1", remote);
    // The list has returned, so s1 is a known rev-0 doc: a buffer based on
    // another revision is stale and the server wins from the first paint.
    expect(binding.initialText).toBe("");

    server.rows.set("s1", {
      scope: "s1",
      text: "server",
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });
    emit(server, { type: "ws:open" });
    await settle();

    expect(readBuffer("s1")).toBeNull();
    expect(remote).toHaveBeenCalledWith("server");
    expect(server.puts).toHaveLength(0);
  });

  it("buffer_with_current_base_flushed", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    writeBuffer("s1", "local edit", 0);
    const remote = vi.fn();
    const binding = engine.bind("s1", remote);
    expect(binding.initialText).toBe("local edit");

    emit(server, { type: "ws:open" });
    await settle();

    // The list has returned, so the buffer's base (rev 0) matches the known
    // empty doc: the flush happens when the binding is created, and the editor's
    // first paint already carries the text (no remote notification needed).
    expect(server.puts.map((p) => p.text)).toEqual(["local edit"]);
    expect(server.rows.get("s1")?.text).toBe("local edit");
    expect(remote).not.toHaveBeenCalled();

    // Decision 6: a buffer whose editor is gone is still flushed on a refetch.
    writeBuffer("s2", "editor gone", 0);
    emit(server, { type: "ws:open" });
    await settle();
    expect(server.rows.get("s2")?.text).toBe("editor gone");
    expect(readBuffer("s2")).toBeNull();
  });

  it("dirty_mounted_editor_beats_stale_buffer", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    writeBuffer("s1", "stale local", 1);
    const remote = vi.fn();
    const binding = engine.bind("s1", remote);

    binding.save("typing");
    server.rows.set("s1", {
      scope: "s1",
      text: "server",
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });
    emit(server, { type: "ws:open" });
    await settle();

    expect(readBuffer("s1")).toBeNull();
    expect(remote).not.toHaveBeenCalledWith("stale local");

    await vi.advanceTimersByTimeAsync(600);
    await settle();

    // Our PUT lands on top of revision 3, so the pending remote is superseded.
    expect(server.puts.map((p) => p.text)).toEqual(["typing"]);
    expect(server.rows.get("s1")?.text).toBe("typing");
    expect(engine.initialText("s1")).toBe("typing");
  });
});

describe("DraftTextEngine — legacy import (Decision 7)", () => {
  it("legacy_import_after_first_fetch_puts_once_without_binding", async () => {
    localStorage.setItem("vst-chat-draft-s1", "legacy");
    const server = makeServer();
    const engine = await startEngine(server);

    expect(server.puts).toEqual([{ scope: "s1", text: "legacy", clientId: "client-a", keepalive: false }]);
    expect(server.rows.get("s1")?.text).toBe("legacy");
    expect(localStorage.getItem("vst-chat-draft-s1")).toBeNull();
    expect(localStorage.getItem(LEGACY_MIGRATION_MARKER)).toBe("1");

    const binding = engine.bind("s1", () => {});
    expect(binding.initialText).toBe("legacy");
    binding.save("legacy");
    await settle();
    expect(server.puts).toHaveLength(1);
  });

  it("legacy_import_survives_reload", async () => {
    localStorage.setItem("vst-chat-draft-s1", "legacy");
    const server = makeServer();
    const first = await startEngine(server);
    expect(server.rows.get("s1")?.text).toBe("legacy");
    first.stop();

    // A new page on the same server: only the marker is left in localStorage.
    const second = await startEngine(server);
    const binding = second.bind("s1", () => {});
    expect(binding.initialText).toBe("legacy");
  });

  it("legacy_import_never_overwrites_text_typed_before_first_fetch", async () => {
    localStorage.setItem("vst-chat-draft-s1", "legacy");
    const server = makeServer();
    const api = makeApi(server);
    let resolveList: () => void = () => {};
    const listHeld = new Promise<void>((resolve) => {
      resolveList = resolve;
    });
    api.listDraftTexts = async () => {
      await listHeld;
      return [...server.rows.values()].map((r) => ({ ...r }));
    };

    const engine = new DraftTextEngine(api, "client-a");
    engine.start();
    started.push(engine);

    const remote = vi.fn();
    const binding = engine.bind("s1", remote);
    expect(binding.initialText).toBe("legacy");

    // Typed before the first fetch returns. Its PUT is in flight, so the docs
    // cache still holds the (empty) fetched doc when the import runs.
    server.holdApply = true;
    binding.save("legacy typed");

    resolveList();
    await settle();
    expect(server.puts.map((p) => p.text)).toEqual(["legacy typed"]);

    releaseApply(server);
    await settle();
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    // The typed text was already flushing, so the import must not replace it.
    expect(server.rows.get("s1")?.text).toBe("legacy typed");
    expect(server.puts.map((p) => p.text)).toEqual(["legacy typed"]);
    expect(remote).not.toHaveBeenCalledWith("legacy");
    expect(localStorage.getItem("vst-chat-draft-s1")).toBeNull();
    expect(localStorage.getItem(LEGACY_MIGRATION_MARKER)).toBe("1");
  });
});

describe("DraftTextEngine — offline conflict (Decision 6)", () => {
  it("offline_edit_then_server_change_converges_to_editor_on_reconnect", async () => {
    const server = makeServer();
    server.rows.set("s1", {
      scope: "s1",
      text: "base",
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });
    const engine = await startEngine(server);
    const remote = vi.fn();
    const binding = engine.bind("s1", remote);
    expect(binding.initialText).toBe("base");

    server.fail = new TypeError("network");
    binding.save("base +B");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts).toHaveLength(1);

    server.fail = null;
    server.rows.set("s1", {
      scope: "s1",
      text: "server",
      revision: 4,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });
    emit(server, { type: "ws:open" });
    await settle();

    // The mounted dirty editor wins by flush order; the ack drops the pending remote.
    expect(server.puts.map((p) => p.text)).toEqual(["base +B", "base +B"]);
    expect(server.rows.get("s1")?.text).toBe("base +B");
    expect(server.rows.get("s1")?.revision).toBe(5);
    expect(pendingOf(engine, "s1")).toBeNull();
    expect(remote).not.toHaveBeenCalledWith("server");
  });

  it("unbound_dirty_record_yields_to_server_on_reconnect", async () => {
    const server = makeServer();
    const engine = await startEngine(server);

    server.fail = new TypeError("network");
    engine.append("s2", "x");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts.map((p) => p.text)).toEqual(["x"]);

    server.fail = null;
    server.rows.set("s2", {
      scope: "s2",
      text: "srv",
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId: "client-b",
    });
    emit(server, { type: "ws:open" });
    await settle();

    expect(server.puts.map((p) => p.text)).toEqual(["x"]);
    expect(engine.initialText("s2")).toBe("srv");
    expect(readBuffer("s2")).toBeNull();
  });
});

describe("DraftTextEngine — retry", () => {
  it("failed_put_retries_with_backoff_while_ws_open", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    server.fail = new TypeError("network");
    binding.save("x");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts).toHaveLength(1);

    // Retry 1 at +1 s, still failing.
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(server.puts).toHaveLength(2);

    // Retry 2 at +2 s, now succeeding.
    server.fail = null;
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(server.puts).toHaveLength(3);
    expect(server.rows.get("s1")?.text).toBe("x");
    expect(readBuffer("s1")).toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(server.puts).toHaveLength(3);
  });

  it("retry_backoff_caps_at_30s_and_resets_on_success", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    server.fail = new TypeError("network");
    binding.save("x");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts).toHaveLength(1);

    for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      const before = server.puts.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      await settle();
      expect(server.puts.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(server.puts.length).toBe(before + 1);
    }

    // Success resets the backoff: the next failure retries after 1 s again.
    server.fail = null;
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(server.rows.get("s1")?.text).toBe("x");

    server.fail = new TypeError("network");
    binding.save("y");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    const before = server.puts.length;
    await vi.advanceTimersByTimeAsync(999);
    await settle();
    expect(server.puts.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(server.puts.length).toBe(before + 1);
  });

  it("retry_sends_latest_text_not_failed_text", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    server.fail = new TypeError("network");
    binding.save("a");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts.map((p) => p.text)).toEqual(["a"]);

    // Type again just before the retry fires; the debounce has not fired yet.
    await vi.advanceTimersByTimeAsync(900);
    await settle();
    binding.save("ab");
    server.fail = null;
    await vi.advanceTimersByTimeAsync(100);
    await settle();

    expect(server.puts.map((p) => p.text)).toEqual(["a", "ab"]);
    expect(server.rows.get("s1")?.text).toBe("ab");

    // The debounce timer was superseded by the retry's PUT.
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(server.puts).toHaveLength(2);
  });

  it("no_retry_on_4xx", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    server.fail = new ApiError("draft too large", 413, "draft_too_large");
    binding.save("big");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(server.puts).toHaveLength(1);

    server.fail = new ApiError("scope not found", 404, "scope_not_found");
    binding.save("changed");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(server.puts).toHaveLength(2);
  });

  it("online_event_retries_immediately", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    server.fail = new TypeError("network");
    binding.save("x");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts).toHaveLength(1);

    server.fail = null;
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    window.dispatchEvent(new Event("online"));
    await settle();

    expect(server.puts.map((p) => p.text)).toEqual(["x", "x"]);
    expect(server.rows.get("s1")?.text).toBe("x");

    // The 1 s retry timer was replaced by the immediate one.
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(server.puts).toHaveLength(2);
  });

  it("stop_clears_retry_timers", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    server.fail = new TypeError("network");
    binding.save("x");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts).toHaveLength(1);

    engine.stop();
    server.fail = null;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(server.puts).toHaveLength(1);
  });

  it("stop_during_inflight_failure_arms_no_retry", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    // The PUT fails only once it is in flight — after `stop()` has run.
    server.fail = new TypeError("network");
    server.holdReject = true;
    binding.save("x");
    await vi.advanceTimersByTimeAsync(600);
    expect(server.puts).toHaveLength(1);
    expect(server.heldRejects).toHaveLength(1);

    engine.stop();
    rejectHeld(server);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(server.puts).toHaveLength(1);
  });
});

describe("DraftTextEngine — cap + lifecycle", () => {
  it("413_keeps_local_no_retry_loop", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    server.fail = new ApiError("draft too large", 413, "draft_too_large");
    binding.save("big");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts).toHaveLength(1);
    expect(engine.initialText("s1")).toBe("big");

    // A flush (blur/send/unmount) must not retry the rejected text.
    binding.flush();
    await settle();
    expect(server.puts).toHaveLength(1);

    // A different text is allowed through.
    binding.save("big but changed");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(server.puts).toHaveLength(2);
  });

  it("pagehide_writes_buffer_and_skips_keepalive_over_60KiB", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    const big = "a".repeat(61 * 1024);
    binding.save(big);
    window.dispatchEvent(new Event("pagehide"));
    await settle();

    expect(readBuffer("s1")?.text).toBe(big);
    expect(server.puts).toHaveLength(0);

    binding.save("small");
    window.dispatchEvent(new Event("pagehide"));
    await settle();

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]?.keepalive).toBe(true);
  });

  it("initial_fetch_on_create", async () => {
    const server = makeServer();
    const api = makeApi(server);
    const list = vi.spyOn(api, "listDraftTexts");

    ensureDraftTextSync(api as unknown as ApiInstance);
    const engine = engineFor(api as unknown as ApiInstance);
    if (engine) started.push(engine);
    await settle();
    expect(list).toHaveBeenCalledTimes(1);

    ensureDraftTextSync(api as unknown as ApiInstance);
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("final_404_drops_the_buffer_and_stops_reconnect_replying", async () => {
    // A legacy key for a long-deleted session: the import PUT is answered 404.
    localStorage.setItem("vst-chat-draft-gone-session", "old text");
    const server = makeServer();
    server.fail = new ApiError("scope not found", 404, "scope_not_found");
    await startEngine(server);

    expect(server.puts.map((p) => p.scope)).toEqual(["gone-session"]);
    expect(readBuffer("gone-session")).toBeNull();

    // Neither reconnect path may re-PUT a gone scope.
    server.fail = null;
    emit(server, { type: "ws:open" });
    await settle();
    emit(server, { type: "ws:resync" });
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(server.puts).toHaveLength(1);
    expect(readBuffer("gone-session")).toBeNull();
  });

  it("session_deleted_clears_its_scope_buffer", async () => {
    const server = makeServer();
    const engine = await startEngine(server);
    const binding = engine.bind("s1", () => {});

    binding.save("typed");
    expect(readBuffer("s1")?.text).toBe("typed");

    emit(server, { type: "session:deleted", sessionId: "s1" });
    expect(readBuffer("s1")).toBeNull();

    // The pending debounce is dropped and nothing may be written again.
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    binding.save("typed more");
    binding.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(server.puts).toHaveLength(0);
    expect(readBuffer("s1")).toBeNull();
    expect(engine.initialText("s1")).toBe("typed");
  });

  it("global_prompt_snapshot_taken_at_creation", async () => {
    const prompt = (text: string) =>
      JSON.stringify({ state: { draft: { draftPrompt: text, draftConfig: { entryPoint: "global" } } }, version: 0 });
    localStorage.setItem("vst-global-draft", prompt("draft prompt"));

    const engine = new DraftTextEngine(makeApi(makeServer()), "client-a");
    expect(engine.globalPromptSnapshot).toBe("draft prompt");

    localStorage.setItem("vst-global-draft", prompt("changed later"));
    expect(engine.globalPromptSnapshot).toBe("draft prompt");
  });
});
