// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import type { SessionStream } from "../ws/streams/sessionStream.js";

function makeStub(): SessionStream {
  return {
    attach: async () => {},
    write: () => {},
    resize: () => {},
    detach: async () => {},
    on: () => ({}) as any,
    once: () => ({}) as any,
    off: () => ({}) as any,
    emit: () => false,
    addListener: () => ({}) as any,
    removeListener: () => ({}) as any,
    removeAllListeners: () => ({}) as any,
    listeners: () => [],
    rawListeners: () => [],
    listenerCount: () => 0,
    prependListener: () => ({}) as any,
    prependOnceListener: () => ({}) as any,
    eventNames: () => [],
    getMaxListeners: () => 10,
    setMaxListeners: () => ({}) as any,
  } as unknown as SessionStream;
}

describe("directPtyRegistry", () => {
  beforeEach(() => {
    directPtyRegistry.clear();
  });

  it("1.T1 — set/get round-trip returns the same object", () => {
    const stub = makeStub();
    directPtyRegistry.set("sess-1", stub);
    expect(directPtyRegistry.get("sess-1")).toBe(stub);
  });

  it("1.T1 — delete removes the entry", () => {
    const stub = makeStub();
    directPtyRegistry.set("sess-2", stub);
    directPtyRegistry.delete("sess-2");
    expect(directPtyRegistry.has("sess-2")).toBe(false);
  });

  it("1.T1 — delete is idempotent (no throw on missing key)", () => {
    expect(() => directPtyRegistry.delete("does-not-exist")).not.toThrow();
  });

  it("1.T1 — multiple entries are independent", () => {
    const a = makeStub();
    const b = makeStub();
    directPtyRegistry.set("a", a);
    directPtyRegistry.set("b", b);
    expect(directPtyRegistry.get("a")).toBe(a);
    expect(directPtyRegistry.get("b")).toBe(b);
    directPtyRegistry.delete("a");
    expect(directPtyRegistry.has("a")).toBe(false);
    expect(directPtyRegistry.has("b")).toBe(true);
  });
});
