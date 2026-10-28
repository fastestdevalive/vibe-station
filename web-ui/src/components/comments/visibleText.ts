/**
 * Display-only counterpart of `sanitize_review_text` / `is_invisible` in
 * `rust/vst-types/src/review_format.rs`. Stored comment text and quotes keep
 * bidi and zero-width characters (a quote must still match the file); anywhere
 * the web UI shows them they appear as `<U+202E>` so they cannot hide text.
 */
// Bidi / zero-width / invisible-format characters, written as escapes so the source stays readable. Includes
// tag characters (U+E0000-E007F, "ASCII smuggling"), variation selectors, interlinear annotation, the
// combining grapheme joiner, Hangul fillers and the soft hyphen.
/* eslint-disable no-misleading-character-class -- the combining/selector characters ARE the match targets */
const INVISIBLE = new RegExp(
  "[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069" +
    "\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]",
  "gu",
);
/* eslint-enable no-misleading-character-class */
// C0 controls except \n and \t, DEL, and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const SKIN_TONE = /^[\u{1F3FB}-\u{1F3FF}]$/u;

/** Marker text for a code point, e.g. `<U+202E>`. */
function marker(ch: string): string {
  return `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`;
}

/**
 * Emoji sequences keep their U+FE0E/U+FE0F presentation selector (directly after a pictographic base) and
 * their U+200D joiner (between two pictographic characters). A lone selector/ZWJ, one after text or after
 * another invisible, VS1-14, tags and bidi controls are still shown. Mirrors `is_invisible_in_context` in
 * `review_format.rs` (which approximates Extended_Pictographic with a range table).
 */
export function showInvisibles(s: string): string {
  const chars = Array.from(s.replace(CONTROLS, ""));
  let prevEmoji = false;
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    INVISIBLE.lastIndex = 0;
    let flagged = INVISIBLE.test(ch);
    const selector = ch === "\uFE0E" || ch === "\uFE0F";
    if (flagged) {
      if (selector) flagged = !prevEmoji;
      else if (ch === "\u200D") flagged = !(prevEmoji && PICTOGRAPHIC.test(chars[i + 1] ?? ""));
    }
    prevEmoji = PICTOGRAPHIC.test(ch) || SKIN_TONE.test(ch) || (prevEmoji && selector && !flagged);
    out += flagged ? marker(ch) : ch;
  }
  return out;
}
