import type { BuiltinTheme, Highlighter } from "shiki";

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
