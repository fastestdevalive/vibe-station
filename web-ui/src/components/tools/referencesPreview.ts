/**
 * Windowing for a reference row's one-line preview.
 *
 * `preview` is the RAW source line (the daemon no longer trims it), and
 * `character`/`endCharacter` are UTF-16 columns into that same raw line — so
 * the match is located positionally, never by searching for the symbol text
 * (which would mark the wrong occurrence, or a `Self`/alias reference that
 * doesn't spell the queried symbol at all).
 */
export interface PreviewWindow {
  /** The text to render (may carry a leading/trailing "…"). */
  text: string;
  /** Offset of the match within `text`, or -1 when there is nothing to mark. */
  matchStart: number;
  matchLength: number;
}

/** Resolve the matched span `[start, end)` within `line`, or null when
 *  `character` doesn't index into it (an inconsistent response — render the
 *  line without a mark rather than marking the wrong text). */
export function matchSpan(
  line: string,
  character: number,
  endCharacter: number | null | undefined,
  fallbackLength: number,
): { start: number; end: number } | null {
  if (!Number.isInteger(character) || character < 0 || character >= line.length) return null;
  const end =
    typeof endCharacter === "number" && endCharacter > character && endCharacter <= line.length
      ? endCharacter
      : Math.min(line.length, character + Math.max(1, fallbackLength));
  return { start: character, end };
}

/**
 * A window of the raw line around the match: up to `charsBefore` characters
 * of context before it and `charsAfter` after, with the line's own leading
 * indentation and trailing whitespace never counted as context (a deeply
 * indented line reads the same as a trimmed one, but the column math stays
 * on the untrimmed line).
 */
export function previewWindow(
  line: string,
  character: number,
  endCharacter: number | null | undefined,
  fallbackLength: number,
  charsBefore = 30,
  charsAfter = 60,
): PreviewWindow {
  if (!line) return { text: "", matchStart: -1, matchLength: 0 };
  const firstNonWs = Math.max(0, line.search(/\S/));
  const contentEnd = line.trimEnd().length;
  const span = matchSpan(line, character, endCharacter, fallbackLength);

  if (!span) {
    const end = Math.min(contentEnd, firstNonWs + charsBefore + charsAfter);
    return {
      text: line.slice(firstNonWs, end) + (end < contentEnd ? "…" : ""),
      matchStart: -1,
      matchLength: 0,
    };
  }

  const winStart = Math.max(span.start - charsBefore, Math.min(firstNonWs, span.start));
  const winEnd = Math.max(span.end, Math.min(contentEnd, span.end + charsAfter));
  const prefix = winStart > firstNonWs ? "…" : "";
  const suffix = winEnd < contentEnd ? "…" : "";
  return {
    text: prefix + line.slice(winStart, winEnd) + suffix,
    matchStart: span.start - winStart + prefix.length,
    matchLength: span.end - span.start,
  };
}

/**
 * Split a reference group's path into the file name (shown first) and its
 * directory (shown dimmed to the right, truncated from the LEFT so the part
 * nearest the file survives). External directories are shortened: the home
 * directory becomes `~` and a cargo registry checkout collapses to
 * `registry/…`, since the full absolute path is noise (it stays in `title`).
 */
export function splitGroupPath(
  path: string,
  external: boolean,
): { name: string; dir: string } {
  const clean = path.replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  let dir = slash > 0 ? clean.slice(0, slash) : "";
  if (external) {
    dir = dir
      .replace(/^.*\/\.cargo\/registry\/src\/[^/]+/, "registry")
      .replace(/^\/(?:home|Users)\/[^/]+/, "~");
  } else {
    dir = dir.replace(/^\/+/, "");
  }
  return { name, dir };
}
