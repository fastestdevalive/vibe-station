import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectUrlLru } from "./objectUrlLru";

const blob = (text: string) => new Blob([text]);

function spies() {
  return {
    create: vi.spyOn(URL, "createObjectURL"),
    revoke: vi.spyOn(URL, "revokeObjectURL"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ObjectUrlLru", () => {
  it("evicts the least-recently-used entry and revokes it once", () => {
    const { revoke } = spies();
    const lru = new ObjectUrlLru(2);

    const a = lru.put("a", blob("a"));
    const b = lru.put("b", blob("b"));
    const c = lru.put("c", blob("c"));

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(a);
    expect(lru.get("a")).toBeNull();
    expect(lru.get("b")).toBe(b);
    expect(lru.get("c")).toBe(c);
  });

  it("a read makes the entry most-recent, so the next put evicts another", () => {
    const { revoke } = spies();
    const lru = new ObjectUrlLru(2);

    lru.put("a", blob("a"));
    const b = lru.put("b", blob("b"));
    const c = lru.put("c", blob("c"));
    lru.get("b");
    const d = lru.put("d", blob("d"));

    expect(lru.get("b")).toBe(b);
    expect(lru.get("c")).toBeNull();
    expect(lru.get("d")).toBe(d);
    expect(revoke).toHaveBeenCalledWith(c);
  });

  it("pinned entries survive over-capacity and are evicted when unpinned", () => {
    const { revoke } = spies();
    const lru = new ObjectUrlLru(1);

    const a = lru.put("a", blob("a"));
    const unpinA = lru.pin("a");
    // The owners pin a key before its blob arrives (see `useBakedWallpaper`), so
    // a pinned entry can be put into a cache that is already over capacity.
    const unpinB = lru.pin("b");
    const b = lru.put("b", blob("b"));

    expect(lru.get("a")).toBe(a);
    expect(lru.get("b")).toBe(b);
    expect(revoke).not.toHaveBeenCalled();

    // Unpinning the least-recently-used one lets the sweep evict it.
    unpinA();

    expect(revoke).toHaveBeenCalledWith(a);
    expect(lru.get("a")).toBeNull();
    expect(lru.get("b")).toBe(b);

    unpinB();
    expect(lru.get("b")).toBe(b);
  });

  it("put of a known key reuses its URL instead of creating a second one", () => {
    const { create } = spies();
    const lru = new ObjectUrlLru(2);

    const first = lru.put("a", blob("a"));
    const second = lru.put("a", blob("different bytes"));

    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("clear revokes everything it holds", () => {
    const { revoke } = spies();
    const lru = new ObjectUrlLru(2);
    const a = lru.put("a", blob("a"));
    const b = lru.put("b", blob("b"));

    lru.clear();

    expect(revoke).toHaveBeenCalledWith(a);
    expect(revoke).toHaveBeenCalledWith(b);
    expect(lru.get("a")).toBeNull();
    expect(lru.get("b")).toBeNull();
  });
});
