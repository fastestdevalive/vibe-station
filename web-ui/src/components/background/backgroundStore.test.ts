import { describe, expect, it } from "vitest";
import { transparencyFromOpacity } from "./chromeTransparency";
import { stableWallpaperIndex } from "./hash";
import {
  BG_SCHEMA_VERSION,
  NEW_DRAFT_KEY,
  __resetBackgroundStoreForTests,
  createBackgroundStore,
  defaultPrefs,
  getBackgroundStore,
  type ScopeKey,
} from "./backgroundStore";

const IDS = Array.from({ length: 31 }, (_, i) => `wp-${String(i + 1).padStart(3, "0")}`);

function keyFor(serverKey: string): string {
  return `vst.background.v1:${serverKey}`;
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  let writes = 0;
  const storage = {
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      writes += 1;
      map.set(k, v);
    },
  };
  return {
    storage,
    get writes() {
      return writes;
    },
    read: (k: string): string | null => map.get(k) ?? null,
    seed: (k: string, v: string): void => {
      map.set(k, v);
    },
  };
}

function throwingStorage() {
  return {
    getItem: (): string | null => {
      throw new Error("storage blocked");
    },
    setItem: (): void => {
      throw new Error("storage blocked");
    },
  };
}

describe("backgroundStore", () => {
  it("defaults when storage throws", () => {
    const store = createBackgroundStore(throwingStorage(), "srv");
    expect(store.getState()).toEqual(defaultPrefs());
    expect(() => store.patch({ mode: "solid" })).not.toThrow();
    expect(store.getState().mode).toBe("solid");
  });

  it("defaults when storage is null (in-memory only)", () => {
    const store = createBackgroundStore(null, "srv");
    store.patch({ emptyVisibility: 0.5 });
    expect(store.getState().emptyVisibility).toBe(0.5);
    expect(store.getState()).toEqual({ ...defaultPrefs(), emptyVisibility: 0.5 });
  });

  it("corrupt json yields defaults and does not write", () => {
    const h = fakeStorage({ [keyFor("srv")]: "{not json" });
    const store = createBackgroundStore(h.storage, "srv");
    expect(store.getState()).toEqual(defaultPrefs());
    expect(h.writes).toBe(0);
    expect(h.read(keyFor("srv"))).toBe("{not json");
  });

  it("wrong version yields defaults", () => {
    const raw = JSON.stringify({ ...defaultPrefs(), v: 3, mode: "solid", wallpaperId: "wp-001" });
    const h = fakeStorage({ [keyFor("srv")]: raw });
    const store = createBackgroundStore(h.storage, "srv");
    expect(store.getState()).toEqual(defaultPrefs());
    expect(h.writes).toBe(0);
  });

  it("reads v1 data with every value kept and the default gradient (U7)", () => {
    const v1 = { v: 1, mode: "solid", wallpaperId: "wp-001", texture: "hex" };
    const h = fakeStorage({ [keyFor("srv")]: JSON.stringify(v1) });
    const store = createBackgroundStore(h.storage, "srv");
    const state = store.getState();
    expect(state.mode).toBe("solid");
    expect(state.wallpaperId).toBe("wp-001");
    expect(state.texture).toBe("hex");
    expect(state.gradient).toBe("fade_to_theme");
    expect(state.v).toBe(2);
    // A read never rewrites: the next real write upgrades the stored blob.
    expect(h.writes).toBe(0);
    expect(JSON.parse(h.read(keyFor("srv")) as string)).toEqual(v1);
  });

  it("unknown gradient reads the default without rewriting storage", () => {
    const raw = JSON.stringify({ ...defaultPrefs(), gradient: "bogus" });
    const h = fakeStorage({ [keyFor("srv")]: raw });
    const store = createBackgroundStore(h.storage, "srv");
    expect(store.getState().gradient).toBe("fade_to_theme");
    expect(h.writes).toBe(0);
    expect(h.read(keyFor("srv"))).toBe(raw);
  });

  it("patch persists the gradient as schema v2", () => {
    const h = fakeStorage();
    const store = createBackgroundStore(h.storage, "srv");
    store.patch({ gradient: "top_fade" });
    const stored = JSON.parse(h.read(keyFor("srv")) as string) as { v: number; gradient: string };
    expect(stored.gradient).toBe("top_fade");
    expect(stored.v).toBe(2);
    expect(store.getState().gradient).toBe("top_fade");
  });

  it("clamps out-of-range numbers on read", () => {
    const raw = JSON.stringify({
      ...defaultPrefs(),
      emptyVisibility: 5,
      sessionVisibility: -1,
      chromeOpacity: 0.1,
      intensity: 3,
    });
    const store = createBackgroundStore(fakeStorage({ [keyFor("srv")]: raw }).storage, "srv");
    const state = store.getState();
    expect(state.emptyVisibility).toBe(1);
    expect(state.sessionVisibility).toBe(0.1);
    expect(state.chromeOpacity).toBe(0.4);
    expect(state.intensity).toBe(1);
  });

  it("an out-of-range stored chrome opacity clamps in memory, reads as full transparency and is not rewritten", () => {
    const raw = JSON.stringify({ ...defaultPrefs(), chromeOpacity: 0.2 });
    const h = fakeStorage({ [keyFor("srv")]: raw });
    const store = createBackgroundStore(h.storage, "srv");

    expect(store.getState().chromeOpacity).toBe(0.4);
    expect(transparencyFromOpacity(store.getState().chromeOpacity)).toBe(60);
    expect(h.read(keyFor("srv"))).toBe(raw);
  });

  it("ensureRolled rolls once", () => {
    const h = fakeStorage();
    const store = createBackgroundStore(h.storage, "srv");
    store.ensureRolled(["wp-001", "wp-002", "wp-003"], () => 0);
    expect(store.getState().rolled).toBe(true);
    expect(store.getState().wallpaperId).toBe("wp-001");
    expect(store.getState().texture).toBe("none");
    // A roll is a system pick: the picker's chip shows (R1F-09).
    expect(store.getState().picked).toBe(true);
    const writes = h.writes;
    store.ensureRolled(["wp-003", "wp-002", "wp-001"], () => 0.99);
    expect(store.getState().wallpaperId).toBe("wp-001");
    expect(store.getState().texture).toBe("none");
    expect(h.writes).toBe(writes);
  });

  it("picked is false by default, false for a stored entry without it, and patchable", () => {
    expect(defaultPrefs().picked).toBe(false);

    // An entry written before the field existed (no schema bump: per-field
    // validation degrades).
    const legacy: Record<string, unknown> = { ...defaultPrefs() };
    delete legacy.picked;
    const h = fakeStorage({ [keyFor("srv")]: JSON.stringify(legacy) });
    const store = createBackgroundStore(h.storage, "srv");
    expect(store.getState().picked).toBe(false);
    expect(h.writes).toBe(0);

    store.patch({ picked: true });
    expect(store.getState().picked).toBe(true);
    store.patch({ picked: false });
    expect(store.getState().picked).toBe(false);

    // A stored `true` survives a read.
    const seeded = fakeStorage({ [keyFor("srv")]: JSON.stringify({ ...defaultPrefs(), picked: true }) });
    expect(createBackgroundStore(seeded.storage, "srv").getState().picked).toBe(true);
  });

  it("ensureRolled writes nothing for an empty catalog", () => {
    const h = fakeStorage();
    const store = createBackgroundStore(h.storage, "srv");
    store.ensureRolled([], () => 0);
    expect(store.getState().rolled).toBe(false);
    expect(store.getState().wallpaperId).toBeNull();
    expect(h.writes).toBe(0);
  });

  it("seed is write-once", () => {
    const store = createBackgroundStore(null, "srv");
    store.writeSeedIfAbsent("worktree:w1", "wp-001");
    store.writeSeedIfAbsent("worktree:w1", "wp-002");
    expect(store.getState().seeds["worktree:w1"]).toBe("wp-001");
  });

  it("override set and reset", () => {
    const store = createBackgroundStore(null, "srv");
    const scope: ScopeKey = "worktree:w1";
    store.setOverride(scope, { kind: "id", id: "wp-004" });
    expect(store.getState().overrides[scope]).toEqual({ kind: "id", id: "wp-004" });
    store.setOverride(scope, { kind: "none" });
    expect(store.getState().overrides[scope]).toEqual({ kind: "none" });
    store.setOverride(scope, null);
    expect(store.getState().overrides[scope]).toBeUndefined();
    const before = store.getState();
    store.setOverride(scope, null);
    expect(store.getState()).toBe(before);
  });

  it("unknown texture reads none but is not rewritten", () => {
    const raw = JSON.stringify({ ...defaultPrefs(), texture: "sparkles" });
    const h = fakeStorage({ [keyFor("srv")]: raw });
    const store = createBackgroundStore(h.storage, "srv");
    expect(store.getState().texture).toBe("none");
    expect(h.writes).toBe(0);
    expect(JSON.parse(h.read(keyFor("srv")) as string).texture).toBe("sparkles");
  });

  it("unknown wallpaper id kept", () => {
    const raw = JSON.stringify({ ...defaultPrefs(), wallpaperId: "wp-999" });
    const store = createBackgroundStore(fakeStorage({ [keyFor("srv")]: raw }).storage, "srv");
    expect(store.getState().wallpaperId).toBe("wp-999");
  });

  it("draftWallpaperFor is stable and capped at 50", () => {
    const store = createBackgroundStore(null, "srv");
    const first = store.draftWallpaperFor("draft-1", IDS);
    expect(first).toBe(IDS[stableWallpaperIndex("draft-1", IDS.length)]);
    expect(store.draftWallpaperFor("draft-1", IDS)).toBe(first);
    for (let i = 0; i < 50; i += 1) store.draftWallpaperFor(`d${i}`, IDS);
    const drafts = store.getState().drafts;
    expect(Object.keys(drafts)).toHaveLength(50);
    expect(drafts["draft-1"]).toBeUndefined();
    expect(drafts["d0"]).toBeDefined();
    expect(drafts["d49"]).toBeDefined();
    expect(store.draftWallpaperFor("draft-1", IDS)).toBe(first);
  });

  it("draftWallpaperFor with empty catalog writes nothing", () => {
    const h = fakeStorage();
    const store = createBackgroundStore(h.storage, "srv");
    expect(store.draftWallpaperFor(NEW_DRAFT_KEY, [])).toBeNull();
    expect(store.getState().drafts).toEqual({});
    expect(h.writes).toBe(0);
  });

  it("forgetDraft removes the key", () => {
    const store = createBackgroundStore(null, "srv");
    store.draftWallpaperFor(NEW_DRAFT_KEY, IDS);
    expect(store.getState().drafts[NEW_DRAFT_KEY]).toBeDefined();
    store.forgetDraft(NEW_DRAFT_KEY);
    expect(store.getState().drafts[NEW_DRAFT_KEY]).toBeUndefined();
    const before = store.getState();
    store.forgetDraft(NEW_DRAFT_KEY);
    expect(store.getState()).toBe(before);
  });

  it("moveDraft re-keys a claimed draft in one write", () => {
    const h = fakeStorage();
    const store = createBackgroundStore(h.storage, "srv");
    store.draftWallpaperFor(NEW_DRAFT_KEY, IDS);
    const claimed = store.getState().drafts[NEW_DRAFT_KEY];
    const writes = h.writes;

    store.moveDraft(NEW_DRAFT_KEY, "sess-draft-2");

    expect(h.writes).toBe(writes + 1);
    expect(store.getState().drafts["sess-draft-2"]).toBe(claimed);
    expect(store.getState().drafts[NEW_DRAFT_KEY]).toBeUndefined();
  });

  it("moveDraft keeps an existing target and no-ops on a missing source", () => {
    const store = createBackgroundStore(null, "srv");
    store.draftWallpaperFor(NEW_DRAFT_KEY, IDS);
    store.draftWallpaperFor("sess-draft-2", IDS);
    const before = store.getState();

    store.moveDraft(NEW_DRAFT_KEY, "sess-draft-2");
    expect(store.getState()).toBe(before);

    store.moveDraft("never-claimed", "sess-draft-3");
    expect(store.getState()).toBe(before);
    expect(store.getState().drafts["sess-draft-3"]).toBeUndefined();
  });

  it("pruneScopes drops dead scopes only", () => {
    const h = fakeStorage();
    const store = createBackgroundStore(h.storage, "srv");
    store.writeSeedIfAbsent("worktree:w1", "wp-001");
    store.writeSeedIfAbsent("worktree:w2", "wp-002");
    store.writeSeedIfAbsent("project:p1", "wp-003");
    store.setOverride("worktree:w1", { kind: "none" });
    store.setOverride("worktree:w3", { kind: "id", id: "wp-004" });
    const writes = h.writes;
    const live = new Set<ScopeKey>(["worktree:w1", "project:p1"]);
    store.pruneScopes(live);
    expect(h.writes).toBe(writes + 1);
    expect(Object.keys(store.getState().seeds).sort()).toEqual(["project:p1", "worktree:w1"]);
    expect(Object.keys(store.getState().overrides)).toEqual(["worktree:w1"]);
    const after = store.getState();
    store.pruneScopes(live);
    expect(store.getState()).toBe(after);
    expect(h.writes).toBe(writes + 1);
  });

  it("getState is referentially stable between writes", () => {
    const store = createBackgroundStore(null, "srv");
    const a = store.getState();
    expect(store.getState()).toBe(a);
    store.patch({ mode: "solid" });
    expect(store.getState()).not.toBe(a);
    expect(store.getState()).toBe(store.getState());
  });

  it("keyed per server", () => {
    const h = fakeStorage();
    const a = createBackgroundStore(h.storage, "http://one");
    const b = createBackgroundStore(h.storage, "http://two");
    a.patch({ wallpaperId: "wp-001" });
    expect(b.getState().wallpaperId).toBeNull();
    expect(h.read(keyFor("http://one"))).not.toBeNull();
    expect(h.read(keyFor("http://two"))).toBeNull();
  });

  it("subscribe fires on patch", () => {
    const store = createBackgroundStore(null, "srv");
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.patch({ agentWallpapers: false });
    expect(calls).toBe(1);
    store.setSection("wallpaper", true);
    expect(calls).toBe(2);
    off();
    store.patch({ agentWallpapers: true });
    expect(calls).toBe(2);
  });

  it("cross-tab storage event reloads and notifies", () => {
    const h = fakeStorage();
    const store = createBackgroundStore(h.storage, "srv");
    const seen: number[] = [];
    const off = store.subscribe(() => seen.push(store.getState().chromeOpacity));
    h.seed(keyFor("srv"), JSON.stringify({ ...defaultPrefs(), chromeOpacity: 0.5 }));
    window.dispatchEvent(new StorageEvent("storage", { key: keyFor("srv") }));
    expect(seen).toEqual([0.5]);
    window.dispatchEvent(new StorageEvent("storage", { key: keyFor("other-server") }));
    expect(seen).toEqual([0.5]);
    off();
    window.dispatchEvent(new StorageEvent("storage", { key: keyFor("srv") }));
    expect(seen).toEqual([0.5]);
  });

  it("re-reads storage when the first subscriber attaches", () => {
    const h = fakeStorage();
    const store = createBackgroundStore(h.storage, "srv");
    const off = store.subscribe(() => {});
    off();

    h.seed(keyFor("srv"), JSON.stringify({ ...defaultPrefs(), chromeOpacity: 0.85 }));

    store.subscribe(() => {});
    expect(store.getState().chromeOpacity).toBe(0.85);
  });

  it("setSection writes and is idempotent", () => {
    const store = createBackgroundStore(null, "srv");
    store.setSection("texture", true);
    expect(store.getState().sections.texture).toBe(true);
    const before = store.getState();
    store.setSection("texture", true);
    expect(store.getState()).toBe(before);
  });

  it("setSection remembers the gradient section", () => {
    const store = createBackgroundStore(null, "srv");
    store.setSection("gradient", true);
    expect(store.getState().sections.gradient).toBe(true);
  });

  it("singleton is created once and resettable", () => {
    __resetBackgroundStoreForTests();
    const one = getBackgroundStore();
    expect(one.getState().v).toBe(BG_SCHEMA_VERSION);
    expect(getBackgroundStore()).toBe(one);
    __resetBackgroundStoreForTests();
    expect(getBackgroundStore()).not.toBe(one);
    __resetBackgroundStoreForTests();
  });
});
