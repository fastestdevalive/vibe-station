import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RENDER_VERSION } from "../textureCatalog";
import {
  BAKED_MEMORY_ENTRIES,
  MAX_BAKE_ENTRIES,
  __resetBakeCacheForTests,
  bakedUrl,
  getBaked,
  getBakedUrl,
  peekBakedUrl,
  pinBaked,
  putBaked,
  rememberBaked,
} from "./bakeCache";

/**
 * jsdom's Blob has no `arrayBuffer`/`text` and is not a valid `BodyInit`, so the
 * Cache API's Response round-trip is stubbed with a body-only stand-in.
 */
class FakeResponse {
  constructor(private readonly body: Blob) {}
  async blob(): Promise<Blob> {
    return this.body;
  }
}

/** A minimal CacheStorage stand-in; jsdom ships no Cache API at all. */
function fakeCacheStorage(store: Map<string, Blob>): CacheStorage {
  const cache = {
    match: async (url: string) => {
      const blob = store.get(url);
      return blob === undefined ? undefined : new FakeResponse(blob);
    },
    put: async (url: string, res: Response) => {
      store.set(url, await res.blob());
    },
    keys: async () => [...store.keys()].map((url) => ({ url })),
    delete: async (target: string | { url: string }) => {
      const url = typeof target === "string" ? target : target.url;
      return store.delete(url);
    },
  };
  return { open: async () => cache } as unknown as CacheStorage;
}

const KEY = `wp-007|dither|dark|1280x800|${RENDER_VERSION}`;

beforeEach(() => {
  __resetBakeCacheForTests();
  vi.stubGlobal("Response", FakeResponse);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetBakeCacheForTests();
});

describe("bakeCache memory tier", () => {
  it("getBakedUrl fills the memory tier from a Cache API hit", async () => {
    const store = new Map<string, Blob>([[bakedUrl(KEY), new Blob(["hello"])]]);
    vi.stubGlobal("caches", fakeCacheStorage(store));

    const url = await getBakedUrl(KEY);

    expect(url).toMatch(/^blob:/);
    expect(peekBakedUrl(KEY)).toBe(url);
  });

  it("peekBakedUrl is null before anything was baked", () => {
    expect(peekBakedUrl(KEY)).toBeNull();
  });

  it("rememberBaked is synchronous and reusable", () => {
    const url = rememberBaked(KEY, new Blob(["x"]));

    expect(peekBakedUrl(KEY)).toBe(url);
    expect(rememberBaked(KEY, new Blob(["y"]))).toBe(url);
  });

  it("a pinned entry survives an over-capacity sweep", () => {
    const unpin = pinBaked(KEY);
    const url = rememberBaked(KEY, new Blob(["x"]));

    for (let i = 0; i < BAKED_MEMORY_ENTRIES; i += 1) {
      rememberBaked(`${KEY}#${i}`, new Blob(["y"]));
    }

    expect(peekBakedUrl(KEY)).toBe(url);
    unpin();
  });

  it("__resetBakeCacheForTests clears the memory tier", () => {
    rememberBaked(KEY, new Blob(["x"]));

    __resetBakeCacheForTests();

    expect(peekBakedUrl(KEY)).toBeNull();
  });
});

describe("bakeCache", () => {
  it("returns null when caches is undefined", async () => {
    vi.stubGlobal("caches", undefined);

    await expect(getBaked(KEY)).resolves.toBeNull();
    await expect(putBaked(KEY, new Blob(["x"]))).resolves.toBeUndefined();
  });

  it("roundtrips with a fake CacheStorage", async () => {
    const store = new Map<string, Blob>();
    vi.stubGlobal("caches", fakeCacheStorage(store));

    await putBaked(KEY, new Blob(["hello"]));

    const got = await getBaked(KEY);
    expect(got).not.toBeNull();
    // jsdom's Blob exposes no text(); size is the content assertion here.
    expect(got!.size).toBe(5);
  });

  it("misses on an unknown key", async () => {
    vi.stubGlobal("caches", fakeCacheStorage(new Map()));

    await expect(getBaked(KEY)).resolves.toBeNull();
  });

  it("evicts entries from an older RENDER_VERSION on first open", async () => {
    const stale = bakedUrl(`wp-007|dither|dark|1280x800|${RENDER_VERSION - 1}`);
    const store = new Map<string, Blob>([[stale, new Blob(["old"])]]);
    vi.stubGlobal("caches", fakeCacheStorage(store));

    await getBaked(KEY);

    expect(store.has(stale)).toBe(false);
  });

  it("keeps current-RENDER_VERSION entries", async () => {
    const keep = bakedUrl(KEY);
    const store = new Map<string, Blob>([[keep, new Blob(["fresh"])]]);
    vi.stubGlobal("caches", fakeCacheStorage(store));

    await getBaked(KEY);

    expect(store.has(keep)).toBe(true);
  });

  it("putBaked keeps at most MAX_BAKE_ENTRIES, dropping the oldest", async () => {
    const store = new Map<string, Blob>();
    vi.stubGlobal("caches", fakeCacheStorage(store));

    const total = MAX_BAKE_ENTRIES + 3;
    for (let i = 0; i < total; i += 1) {
      await putBaked(`key-${i}|dither|dark|1280x800|${RENDER_VERSION}`, new Blob([`body-${i}`]));
    }

    for (let i = 0; i < 3; i += 1) {
      await expect(getBaked(`key-${i}|dither|dark|1280x800|${RENDER_VERSION}`)).resolves.toBeNull();
    }
    const last = await getBaked(`key-${total - 1}|dither|dark|1280x800|${RENDER_VERSION}`);
    expect(last).not.toBeNull();
    expect(last!.size).toBe(`body-${total - 1}`.length);
  });
});
