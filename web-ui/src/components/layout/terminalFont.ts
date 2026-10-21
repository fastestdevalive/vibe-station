/**
 * xterm font setup. Geist Mono is self-hosted (@fontsource), so the first
 * `term.open()` can happen before the webfont is decoded — xterm would then
 * measure cells with the fallback and keep those metrics. We never `await`
 * before `open()` (AGENTS.md "never unmount TerminalPane" relies on mount
 * timing); instead the font is refreshed after it loads.
 */
import type { Terminal } from "@xterm/xterm";

/** Mirrors `--fs-term` in tokens.css. */
export const TERM_BASE_PX = 13;

/** JetBrains Mono stays in the list for glyphs Geist Mono lacks (⎿, box drawing). */
export const TERM_FONT_FAMILY =
  '"Geist Mono", "JetBrains Mono", "Cascadia Code", "Noto Sans Mono", monospace';

/**
 * Re-measure the terminal once Geist Mono is real. xterm only re-measures its
 * cells when `options.fontFamily` actually CHANGES (its option setter guards
 * with `!==`), so re-assigning the same family is a no-op. We therefore assign
 * a different family first, then the real one, in the same task (no flicker),
 * then drop the texture atlas and refit. No-op where `document.fonts` is
 * unavailable (jsdom / old engines) or once disposed.
 */
export function refreshWhenFontReady(
  term: Terminal,
  fit: () => void,
  isDisposed: () => boolean,
): void {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) return;
  void fonts
    .load(`${TERM_BASE_PX}px "Geist Mono"`)
    .then(() => {
      if (isDisposed()) return;
      term.options.fontFamily = "monospace";
      term.options.fontFamily = TERM_FONT_FAMILY;
      term.clearTextureAtlas();
      fit();
    })
    .catch(() => {});
}
