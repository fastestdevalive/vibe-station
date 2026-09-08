import { useEffect, useMemo, useState } from "react";
import type { DiffLine } from "@/preview/diffParser";
import { parseUnifiedDiff, syntheticUntrackedHunks } from "@/preview/diffParser";
import { diffLinesToHunks } from "@/preview/diffFromTexts";
import { segmentMarkdownWithMermaid } from "@/preview/mdSegments";
import { useTheme } from "@/hooks/useTheme";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { MarkdownView } from "./MarkdownView";
import { MermaidView } from "./MermaidView";
import { languageForFilePath } from "./codeHighlight";
import { pickShikiLang } from "./previewLang";
import { escapeHtml, highlightLineHtml } from "./shikiHighlighter";

interface DiffViewProps {
  /** Unified-diff text. Optional when `oldText`/`newText` are supplied instead
   *  (acp-normalize-superset Decision 3). */
  diffText?: string;
  /** Raw file text when diff empty / untracked */
  fileContentFallback?: string;
  /** Structured before/after text — takes precedence over `diffText` when
   *  either is defined (a new file has `oldText` absent, `newText` required). */
  oldText?: string;
  newText?: string;
  /** Used for syntax highlighting (extension → language) */
  filePath?: string;
  themeMode?: "dark" | "light";
  /** Optional — enables the Source/Rendered toggle for `.md` files (Phase 9,
   *  item 8) by threading through to the same `MarkdownView` path the plain
   *  (non-diff) preview uses. Omitted by call sites with no worktree context
   *  (e.g. chat tool-result cards), which simply don't get the toggle. */
  api?: ApiInstance | null;
  worktreeId?: string | null;
  scope?: FileScope;
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
  oldText,
  newText,
  filePath,
  themeMode,
  api,
  worktreeId,
  scope,
}: DiffViewProps) {
  const { theme } = useTheme();
  const mode = themeMode ?? theme;
  const themeId: "dark-plus" | "light-plus" = mode === "light" ? "light-plus" : "dark-plus";

  // Item 8: `.md` files get a Source/Rendered toggle, anchored to the same
  // base-branch/fork-base concept `scope === "branch"` already uses — the
  // "Rendered" side reuses the exact `MarkdownView`/`mdSegments` path the
  // non-diff preview uses (`FilePreviewPane.tsx`'s `isMd` branch), rendering
  // the current full file content (`fileContentFallback`) rather than the
  // diff hunks themselves.
  const [displayMode, setDisplayMode] = useState<"source" | "rendered">("source");
  const isMd = filePath?.toLowerCase().endsWith(".md") ?? false;
  const canRenderMarkdown = isMd && !!fileContentFallback;
  const mdSegments = useMemo(
    () => (canRenderMarkdown ? segmentMarkdownWithMermaid(fileContentFallback!) : []),
    [canRenderMarkdown, fileContentFallback],
  );

  const hljsLang = filePath ? languageForFilePath(filePath) : undefined;
  const shikiLang = pickShikiLang(filePath, hljsLang);

  const hunks = useMemo(() => {
    if (oldText !== undefined || newText !== undefined) {
      return diffLinesToHunks(oldText ?? "", newText ?? "");
    }
    const trimmed = (diffText ?? "").trim();
    if (trimmed.length > 0) return parseUnifiedDiff(diffText ?? "");
    if (fileContentFallback) return syntheticUntrackedHunks(fileContentFallback);
    return [];
  }, [diffText, fileContentFallback, oldText, newText]);

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

  const toggle = canRenderMarkdown ? (
    <div className="preview-diff-mode-toggle" role="group" aria-label="Diff display mode">
      <button
        type="button"
        className={`preview-diff-mode-toggle__btn${displayMode === "source" ? " preview-diff-mode-toggle__btn--active" : ""}`}
        aria-pressed={displayMode === "source"}
        onClick={() => setDisplayMode("source")}
      >
        Source
      </button>
      <button
        type="button"
        className={`preview-diff-mode-toggle__btn${displayMode === "rendered" ? " preview-diff-mode-toggle__btn--active" : ""}`}
        aria-pressed={displayMode === "rendered"}
        onClick={() => setDisplayMode("rendered")}
      >
        Rendered
      </button>
    </div>
  ) : null;

  if (canRenderMarkdown && displayMode === "rendered") {
    return (
      <>
        {toggle}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {mdSegments.map((seg, i) =>
            seg.type === "markdown" ? (
              <MarkdownView
                key={i}
                source={seg.content}
                api={api ?? null}
                worktreeId={worktreeId ?? null}
                scope={scope ?? "worktree"}
                filePath={filePath ?? null}
              />
            ) : (
              <MermaidView key={i} chart={seg.content} theme={mode} />
            ),
          )}
        </div>
      </>
    );
  }

  if (hunks.length === 0) {
    return (
      <div className="empty-state">
        <p>No changes</p>
      </div>
    );
  }

  return (
    <>
      {toggle}
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
    </>
  );
}
