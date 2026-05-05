import { useEffect, useMemo, useState } from "react";
import type { DiffLine } from "@/preview/diffParser";
import { parseUnifiedDiff, syntheticUntrackedHunks } from "@/preview/diffParser";
import { useTheme } from "@/hooks/useTheme";
import { languageForFilePath } from "./codeHighlight";
import { pickShikiLang } from "./previewLang";
import { escapeHtml, highlightLineHtml } from "./shikiHighlighter";

interface DiffViewProps {
  diffText: string;
  /** Raw file text when diff empty / untracked */
  fileContentFallback?: string;
  /** Used for syntax highlighting (extension → language) */
  filePath?: string;
  themeMode?: "dark" | "light";
}

interface FlatDiffRow {
  key: string;
  content: string;
  line: DiffLine;
}

function flattenHunks(hunks: ReturnType<typeof parseUnifiedDiff>): FlatDiffRow[] {
  const rows: FlatDiffRow[] = [];
  let hi = 0;
  for (const hunk of hunks) {
    let li = 0;
    for (const line of hunk.lines) {
      rows.push({ key: `${hi}-${li}`, content: line.content, line });
      li += 1;
    }
    hi += 1;
  }
  return rows;
}

export function DiffView({
  diffText,
  fileContentFallback,
  filePath,
  themeMode,
}: DiffViewProps) {
  const { theme } = useTheme();
  const mode = themeMode ?? theme;
  const themeId: "dark-plus" | "light-plus" = mode === "light" ? "light-plus" : "dark-plus";

  const hljsLang = filePath ? languageForFilePath(filePath) : undefined;
  const shikiLang = pickShikiLang(filePath, hljsLang);

  const hunks = useMemo(() => {
    const trimmed = diffText.trim();
    if (trimmed.length > 0) return parseUnifiedDiff(diffText);
    if (fileContentFallback) return syntheticUntrackedHunks(fileContentFallback);
    return [];
  }, [diffText, fileContentFallback]);

  const flatRows = useMemo(() => flattenHunks(hunks), [hunks]);

  const [highlightedByKey, setHighlightedByKey] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (flatRows.length === 0) {
      setHighlightedByKey(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        flatRows.map(async (row) => {
          const html = await highlightLineHtml(row.content, shikiLang, themeId);
          return [row.key, html] as const;
        }),
      );
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const [k, v] of entries) map[k] = v;
      setHighlightedByKey(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [flatRows, shikiLang, themeId]);

  if (hunks.length === 0) {
    return (
      <div className="empty-state">
        <p>No changes</p>
      </div>
    );
  }

  return (
    <pre className="preview-diff-root">
      {hunks.map((hunk, i) => (
        <div key={i}>
          <div className="preview-diff-hunk-header">{hunk.header}</div>
          {hunk.lines.map((line, j) => {
            const key = `${i}-${j}`;
            const html = highlightedByKey?.[key];
            return (
              <div key={key} className={`diff-line diff-line--${line.type}`}>
                <span className="diff-gutter">{line.oldLineNumber ?? ""}</span>
                <span className="diff-gutter">{line.newLineNumber ?? ""}</span>
                <span className="diff-marker">{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
                <span
                  className={`diff-line-text diff-line-text--${line.type}${html ? " diff-line-text--shiki" : ""}`}
                  dangerouslySetInnerHTML={{
                    __html: html ?? escapeHtml(line.content),
                  }}
                />
              </div>
            );
          })}
        </div>
      ))}
    </pre>
  );
}
