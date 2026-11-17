/**
 * The one bounded object-URL cache, shared by the two owners of wallpaper
 * images (full images in `useWallpaperImage`, bakes in `bakeCache`).
 *
 * Map insertion order is the recency order (a `get` re-inserts the entry), so
 * the least-recently-used unpinned entry is evicted first. Pinned entries are
 * never evicted while a mounted layer shows them; they may exceed the capacity
 * until unpinned. Every URL is revoked exactly once.
 */
export class ObjectUrlLru {
  private readonly urls = new Map<string, string>();
  private readonly pins = new Map<string, number>();

  constructor(private readonly capacity: number) {}

  /** Synchronous; marks the entry most-recent. */
  get(key: string): string | null {
    const url = this.urls.get(key);
    if (url === undefined) return null;
    this.urls.delete(key);
    this.urls.set(key, url);
    return url;
  }

  /** Creates the URL once; returns the existing one when the key is present. */
  put(key: string, blob: Blob): string {
    const existing = this.get(key);
    if (existing !== null) return existing;
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    this.evict();
    return url;
  }

  /** Returns an idempotent unpin; pinned entries survive eviction until then. */
  pin(key: string): () => void {
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    let unpinned = false;
    return () => {
      if (unpinned) return;
      unpinned = true;
      const count = (this.pins.get(key) ?? 1) - 1;
      if (count <= 0) this.pins.delete(key);
      else this.pins.set(key, count);
      this.evict();
    };
  }

  /** Test-only: revoke everything and forget the pins. */
  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.pins.clear();
  }

  private evict(): void {
    while (this.urls.size > this.capacity) {
      const victim = [...this.urls.keys()].find((key) => !this.pins.has(key));
      if (victim === undefined) return;
      const url = this.urls.get(victim);
      if (url !== undefined) URL.revokeObjectURL(url);
      this.urls.delete(victim);
    }
  }
}
