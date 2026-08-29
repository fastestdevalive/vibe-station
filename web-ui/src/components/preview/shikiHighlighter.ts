import type { Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

export async function getShikiHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const { createHighlighter } = await import("shiki");
      return createHighlighter({
        themes: ["dark-plus", "light-plus"],
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
    })();
  }
  return highlighterPromise;
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
  themeId: "dark-plus" | "light-plus",
): Promise<string> {
  const h = await getShikiHighlighter();
  const payload = line.length === 0 ? " " : line;
  try {
    return innerFromShikiHtml(h.codeToHtml(payload, { lang, theme: themeId }));
  } catch {
    try {
      return innerFromShikiHtml(h.codeToHtml(payload, { lang: "plaintext", theme: themeId }));
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
  themeId: "dark-plus" | "light-plus",
): Promise<string[]> {
  const h = await getShikiHighlighter();
  const lineCount = code.split("\n").length;
  let html: string;
  try {
    html = h.codeToHtml(code, { lang, theme: themeId });
  } catch {
    try {
      html = h.codeToHtml(code, { lang: "plaintext", theme: themeId });
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
