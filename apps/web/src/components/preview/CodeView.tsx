import { useMemo } from "react";
import { highlightFileContentByLines, languageForFilePath } from "./codeHighlight";

interface CodeViewProps {
  code: string;
  language?: string;
  /** kept for API compat, unused — hljs always matches tokens to CSS vars */
  themeMode?: "dark" | "light";
  /** When true, renders without gutter (e.g. inside a markdown code block) */
  noGutter?: boolean;
}

export function CodeView({ code, language, noGutter }: CodeViewProps) {
  const lines = useMemo(() => code.split("\n"), [code]);
  const gutterWidth = String(lines.length).length;

  const highlightedLines = useMemo(() => {
    if (!language) return null;
    return highlightFileContentByLines(code, language);
  }, [code, language]);

  return (
    <pre className="workspace-code-viewer">
      {lines.map((line, i) => (
        <div key={i} className="workspace-code-line">
          {!noGutter && (
            <span className="workspace-code-gutter" style={{ minWidth: `${gutterWidth + 2}ch` }}>
              {i + 1}
            </span>
          )}
          {highlightedLines ? (
            <span
              className="workspace-code-content"
              dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? "" }}
            />
          ) : (
            <span className="workspace-code-content">{line}</span>
          )}
        </div>
      ))}
    </pre>
  );
}
