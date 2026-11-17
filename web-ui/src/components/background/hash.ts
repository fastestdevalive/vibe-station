/**
 * Stable hash picks, ported from mobile `Wallpaper.kt` (`fnv1a32` / `stableWallpaperIndex`).
 * Same ids + same keys ⇒ same pick on web and phone, so a worktree keeps one wallpaper
 * across devices.
 */

/** FNV-1a 32-bit hash over the UTF-8 bytes of `s`, as an unsigned integer. */
export function fnv1a32(s: string): number {
  const bytes = new TextEncoder().encode(s);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    // Math.imul keeps the multiply in 32-bit signed space; `>>> 0` below makes it unsigned.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable index in `[0, size)` for `key`; throws on a non-positive size (mobile `require(size > 0)`). */
export function stableWallpaperIndex(key: string, size: number): number {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("stableWallpaperIndex: size must be a positive integer");
  }
  return fnv1a32(key) % size;
}
