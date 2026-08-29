import { useEffect, useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
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
        const out = await highlightDocumentLines(code, shikiLang, themeId);
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
