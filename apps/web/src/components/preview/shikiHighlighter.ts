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
