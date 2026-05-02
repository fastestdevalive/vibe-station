import { useEffect, useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { languageForFilePath } from "./codeHighlight";

interface CodeViewProps {
  code: string;
  language?: string;
  /** Used to pick TSX vs TS etc. for Shiki */
  filePath?: string;
  themeMode?: "dark" | "light";
  /** When true, renders without gutter (e.g. inside a markdown code block) */
  noGutter?: boolean;
}

function pickShikiLang(filePath: string | undefined, hljsLang: string | undefined): string {
  const ext = filePath?.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  if (ext === ".tsx") return "tsx";
  if (ext === ".jsx") return "jsx";
  if (hljsLang === "xml") return "html";
  if (hljsLang === "bash") return "shellscript";

  const map: Record<string, string> = {
    javascript: "javascript",
    typescript: "typescript",
    python: "python",
    json: "json",
    css: "css",
    yaml: "yaml",
    rust: "rust",
    go: "go",
  };
  return map[hljsLang ?? ""] ?? "plaintext";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function innerFromShikiHtml(html: string): string {
  const m = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
  return m?.[1] ?? "";
}

type Highlighter = import("shiki").Highlighter;

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
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
          "xml",
          "plaintext",
        ],
      });
    })();
  }
  return highlighterPromise;
}

export function CodeView({ code, language: languageProp, filePath, themeMode, noGutter }: CodeViewProps) {
  const { theme } = useTheme();
  const mode = themeMode ?? theme;
  const themeId = mode === "light" ? "light-plus" : "dark-plus";

  const language = languageProp ?? (filePath ? languageForFilePath(filePath) : undefined);
  const shikiLang = language ? pickShikiLang(filePath, language) : "plaintext";

  const lines = useMemo(() => code.split("\n"), [code]);
  const gutterWidth = String(lines.length).length;

  const [highlightedLines, setHighlightedLines] = useState<string[] | null>(null);

  useEffect(() => {
    if (!language) {
      setHighlightedLines(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const h = await getHighlighter();
        const split = code.split("\n");
        const out: string[] = [];
        for (const line of split) {
          const payload = line.length === 0 ? " " : line;
          try {
            const html = h.codeToHtml(payload, { lang: shikiLang, theme: themeId });
            out.push(innerFromShikiHtml(html));
          } catch {
            try {
              const html = h.codeToHtml(payload, { lang: "plaintext", theme: themeId });
              out.push(innerFromShikiHtml(html));
            } catch {
              out.push(escapeHtml(line));
            }
          }
        }
        if (!cancelled) setHighlightedLines(out);
      } catch {
        if (!cancelled) setHighlightedLines(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, language, shikiLang, themeId]);

  return (
    <pre className="workspace-code-viewer workspace-code-viewer--shiki">
      {lines.map((line, i) => (
        <div key={i} className="workspace-code-line">
          {!noGutter && (
            <span className="workspace-code-gutter" style={{ minWidth: `${gutterWidth + 2}ch` }}>
              {i + 1}
            </span>
          )}
          {highlightedLines ? (
            <span
              className="workspace-code-content workspace-code-content--shiki"
              dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? escapeHtml(line) }}
            />
          ) : (
            <span className="workspace-code-content">{line}</span>
          )}
        </div>
      ))}
    </pre>
  );
}
