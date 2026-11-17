import bundle from "./draft-quotes.json";
import { stableWallpaperIndex } from "./hash";

/**
 * The draft composer's decorative quote line, ported from mobile `DraftQuotes.kt`:
 * same bundled 71 quotes, same hash key (`quote:<key>`), so a draft shows the same line
 * on every device and launch.
 */

export interface DraftQuote {
  id: string;
  text: string;
}

/** Blank lines are dropped before indexing (mobile `parseDraftQuotes`). */
export const quotes: readonly DraftQuote[] = bundle.quotes.filter((q) => q.text.trim() !== "");

/** The quote for `key`; null when the bundle is empty. */
export function pickDraftQuote(key: string): DraftQuote | null {
  if (quotes.length === 0) return null;
  return quotes[stableWallpaperIndex(`quote:${key}`, quotes.length)] ?? null;
}
