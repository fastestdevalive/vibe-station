import { useEffect, useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { themeById } from "@/theme/registry";
import { languageForFilePath } from "./codeHighlight";
import { pickShikiLang } from "./previewLang";
import { escapeHtml, highlightDocumentLines } from "./shikiHighlighter";

interface CodeViewProps {
  code: string;
  language?: string;
  /** Used to pick TSX vs TS etc. for Shiki */
  filePath?: string;
  themeMode?: "dark" | "light";
  /** When true, renders without gutter (e.g. inside a markdown code block) */
  noGutter?: boolean;
}

export function CodeView({ code, language: languageProp, filePath, themeMode, noGutter }: CodeViewProps) {
  // `themeId` (the full 14-way value from the shared store) resolves to the
  // theme's Shiki id via the registry so syntax highlighting follows the theme.
  const { theme, themeId } = useTheme();
  const mode = themeMode ?? theme;
  // An explicit `themeMode` that differs from the active appearance is a
  // deliberate appearance-only override (e.g. the Settings hover-preview),
  // which carries no full themeId — fall back to the classic dark/light pair.
  const overridden = themeMode !== undefined && themeMode !== theme;
  const shikiThemeId = overridden
    ? mode === "light"
      ? "light-plus"
      : "dark-plus"
    : themeById[themeId]?.shikiThemeId ?? (mode === "light" ? "light-plus" : "dark-plus");

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
        const out = await highlightDocumentLines(code, shikiLang, shikiThemeId);
        if (!cancelled) setHighlightedLines(out);
      } catch {
        if (!cancelled) setHighlightedLines(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, language, shikiLang, shikiThemeId]);

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
