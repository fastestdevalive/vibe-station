import type { BuiltinTheme, GrammarState, Highlighter, ThemedToken } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;
let activeShikiThemeId: string | null = null;
const loadedShikiThemeIds = new Set<string>();

export async function getShikiHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const { createHighlighter } = await import("shiki");
      // Create with only the currently-active theme, never all 14 eagerly.
      // `setActiveTheme` loads any additional theme on demand before it's used.
      const initial = activeShikiThemeId ? [activeShikiThemeId] : [];
      const h = await createHighlighter({
        themes: initial,
        langs: [
          "javascript",
          "typescript",
          "tsx",
          "jsx",
          "json",
          "css",
          "html",
          "yaml",
          "shellscript",
          "python",
          "rust",
          "go",
          "kotlin",
          "groovy",
          "xml",
          "plaintext",
        ],
      });
      if (activeShikiThemeId) loadedShikiThemeIds.add(activeShikiThemeId);
      return h;
    })();
  }
  return highlighterPromise;
}

/**
 * Switch the active Shiki theme, loading it into the highlighter on demand if
 * it hasn't been loaded yet. Already-loaded ids are cached, so re-switching
 * back to a theme never triggers a second `loadTheme`/fetch.
 */
export async function setActiveTheme(shikiThemeId: string): Promise<void> {
  activeShikiThemeId = shikiThemeId;
  if (loadedShikiThemeIds.has(shikiThemeId)) return;
  const h = await getShikiHighlighter();
  // Every registry `shikiThemeId` is a valid bundled Shiki theme (see
  // web-ui/src/theme/registry.ts); cast the string for the typed loadTheme.
  await h.loadTheme(shikiThemeId as BuiltinTheme);
  loadedShikiThemeIds.add(shikiThemeId);
}

/** Test-only: reset module-level singleton state for isolation. */
export function __resetShikiHighlighterForTests(): void {
  highlighterPromise = null;
  activeShikiThemeId = null;
  loadedShikiThemeIds.clear();
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function innerFromShikiHtml(html: string): string {
  const m = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
  return m?.[1] ?? "";
}

export async function highlightLineHtml(
  line: string,
  lang: string,
  shikiThemeId: string,
): Promise<string> {
  await setActiveTheme(shikiThemeId);
  const h = await getShikiHighlighter();
  const payload = line.length === 0 ? " " : line;
  try {
    return innerFromShikiHtml(h.codeToHtml(payload, { lang, theme: shikiThemeId }));
  } catch {
    try {
      return innerFromShikiHtml(h.codeToHtml(payload, { lang: "plaintext", theme: shikiThemeId }));
    } catch {
      return escapeHtml(line);
    }
  }
}

/**
 * Highlights the *entire* document in a single Shiki call so multi-line
 * constructs (block comments, template literals, etc.) keep correct
 * tokenizer state across line boundaries, then splits the result back into
 * one HTML string per source line for per-line rendering.
 *
 * Highlighting line-by-line (as `highlightLineHtml` does) loses that state:
 * a continuation line like ` * foo` inside a `/* ... *\/` block has no way
 * to know it's inside a comment when tokenized alone, so it renders as code.
 */
export async function highlightDocumentLines(
  code: string,
  lang: string,
  shikiThemeId: string,
): Promise<string[]> {
  await setActiveTheme(shikiThemeId);
  const h = await getShikiHighlighter();
  const lineCount = code.split("\n").length;
  let html: string;
  try {
    html = h.codeToHtml(code, { lang, theme: shikiThemeId });
  } catch {
    try {
      html = h.codeToHtml(code, { lang: "plaintext", theme: shikiThemeId });
    } catch {
      return code.split("\n").map(escapeHtml);
    }
  }
  const lines = splitShikiHtmlLines(html);
  if (lines.length === lineCount) return lines;
  // Fallback: structure didn't match what we expected (e.g. no DOMParser, or
  // an unusual renderer output) — degrade gracefully rather than misalign.
  return code.split("\n").map(escapeHtml);
}

function splitShikiHtmlLines(html: string): string[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const codeEl = doc.querySelector("code");
  if (!codeEl) return [];
  const lineEls = codeEl.querySelectorAll(":scope > .line");
  if (lineEls.length === 0) return [];
  return Array.from(lineEls, (el) => el.innerHTML);
}

// ── Chunked highlighting (Phase 3) ─────────────────────────────────────────
// Highlight a *chunk* of a file via `codeToTokens` while carrying the
// tokenizer's `grammarState` across chunk boundaries, so multi-line constructs
// (block comments, template literals) stay exact even when a file is tokenized
// in pieces. This is the state-carrying counterpart to `highlightDocumentLines`
// (which tokenizes the whole document in one call and can't be time-sliced).
//
// HTML step (spike 3.0): option (i) — `codeToTokens` + a small token→`<span>`
// renderer, rather than `codeToHtml` + a DOMParser split. To make the chunked
// output byte-for-byte equal to `highlightDocumentLines`, the renderer must
// mirror Shiki's own `mergeWhitespaceTokens` pass (which folds whitespace-only
// tokens into the following token, so ` foo` keeps the identifier's color) and
// its `getTokenStyleObject`/`stringifyTokenStyle` style serialization. A plain
// per-token renderer would split those whitespace runs into separate default-
// colored spans and drift from the whole-document result.

function shikiMergeWhitespaceTokens(
  tokens: ThemedToken[][],
): ThemedToken[][] {
  return tokens.map((line) => {
    const newLine: ThemedToken[] = [];
    let carryOnContent = "";
    let firstOffset: number | undefined;
    line.forEach((token, idx) => {
      const isDecorated =
        !!token.fontStyle &&
        (token.fontStyle & 4 || token.fontStyle & 8); // underline | strikethrough
      const couldMerge = !isDecorated;
      if (couldMerge && token.content.match(/^\s+$/) && line[idx + 1]) {
        if (firstOffset === undefined) firstOffset = token.offset;
        carryOnContent += token.content;
      } else {
        if (carryOnContent) {
          if (couldMerge) {
            newLine.push({
              ...token,
              offset: firstOffset!,
              content: carryOnContent + token.content,
            });
          } else {
            newLine.push(
              { content: carryOnContent, offset: firstOffset! },
              token,
            );
          }
          firstOffset = undefined;
          carryOnContent = "";
        } else {
          newLine.push(token);
        }
      }
    });
    return newLine;
  });
}

function shikiTokenStyleObject(token: ThemedToken): Record<string, string> {
  const styles: Record<string, string> = {};
  if (token.color) styles.color = token.color;
  if (token.bgColor) styles["background-color"] = token.bgColor;
  if (token.fontStyle) {
    if (token.fontStyle & 2) styles["font-style"] = "italic";
    if (token.fontStyle & 1) styles["font-weight"] = "bold";
    const decorations: string[] = [];
    if (token.fontStyle & 4) decorations.push("underline");
    if (token.fontStyle & 8) decorations.push("line-through");
    if (decorations.length) styles["text-decoration"] = decorations.join(" ");
  }
  return styles;
}

function shikiStringifyTokenStyle(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

/** Render a `codeToTokens` result's token array into one HTML string per line,
 *  matching `highlightDocumentLines`' per-line HTML byte-for-byte. */
export function renderTokensToLines(tokens: ThemedToken[][]): string[] {
  return shikiMergeWhitespaceTokens(tokens).map((line) => {
    if (line.length === 0) return "";
    return line
      .map((t) => {
        // Never emit `style="color:"` for a token with no color (e.g. a line
        // that hit `tokenizeMaxLineLength` and was returned un-tokenized) —
        // an empty style attribute would render a broken/empty `style=""`.
        const style = shikiStringifyTokenStyle(shikiTokenStyleObject(t));
        return style
          ? `<span style="${style}">${escapeHtml(t.content)}</span>`
          : escapeHtml(t.content);
      })
      .join("");
  });
}

export interface HighlightChunkResult {
  /** One HTML string per source line in the chunk. */
  lines: string[];
  /** The tokenizer's end grammar state, to feed into the next chunk. */
  endState: GrammarState | undefined;
}

/**
 * Highlight a chunk of source via `codeToTokens`, optionally continuing from a
 * prior chunk's `grammarState` so multi-line constructs stay exact across chunk
 * boundaries. Returns one HTML string per line plus the end grammar state.
 *
 * Uses `result.grammarState` (NOT `h.getLastGrammarState(result)`) — the
 * WeakMap lookup is for raw `ThemedToken[][]` arrays / hast roots and silently
 * returns `undefined` for a `TokensResult` object.
 */
export async function highlightChunk(
  code: string,
  lang: string,
  shikiThemeId: string,
  grammarState?: GrammarState,
): Promise<HighlightChunkResult> {
  await setActiveTheme(shikiThemeId);
  const h = await getShikiHighlighter();
  const tokens = (langArg: string, state: GrammarState | undefined) =>
    h.codeToTokens(code, {
      // `codeToTokens`'s `lang` is typed as a BundledLanguage union while
      // callers pass an arbitrary resolved string; `codeToHtml` (used by
      // `highlightDocumentLines`) accepts the looser string form.
      lang: langArg as never,
      theme: shikiThemeId,
      grammarState: state,
      // Cap a single minified line so it can't stall a chunk.
      tokenizeMaxLineLength: 20000,
      tokenizeTimeLimit: 250,
    });
  try {
    const result = tokens(lang, grammarState);
    return {
      lines: renderTokensToLines(result.tokens),
      endState: result.grammarState,
    };
  } catch {
    try {
      const result = tokens("plaintext", grammarState);
      return {
        lines: renderTokensToLines(result.tokens),
        endState: result.grammarState,
      };
    } catch {
      return { lines: code.split("\n").map(escapeHtml), endState: undefined };
    }
  }
}
