import { Fragment } from "react";
import type { DiffHunk, DiffLine } from "@/preview/diffParser";
import { pairHunkLines } from "@/preview/diffSideBySide";
import type { DiffGap } from "@/preview/diffGaps";
import { escapeHtml } from "./shikiHighlighter";

interface DiffSideBySideProps {
  hunks: DiffHunk[];
  collapsedHunks: Set<number>;
  lineKeyMap: Map<DiffLine, string>;
  highlightedByKey: Record<string, string> | null;
  onToggleHunk: (index: number) => void;
  onHunkMouseEnter: (index: number) => void;
  onHunkMouseLeave: (index: number) => void;
  /** Same header-element registry `DiffView` uses for its inline branch's
   *  topmost-visible hunk fallback (Decision 4) — kept in sync regardless of
   *  which branch is currently mounted. */
  registerHeaderRef: (index: number, el: HTMLElement | null) => void;
  /** Omitted-context gaps (diff-view-shortcuts-expand-context). */
  gaps: DiffGap[];
  expandedGaps: Set<string>;
  fileLines: string[] | null;
  onToggleGap: (id: string) => void;
}

function renderCell(
  line: DiffLine | null,
  lineKeyMap: Map<DiffLine, string>,
  highlightedByKey: Record<string, string> | null,
  isNewSide: boolean,
) {
  if (!line) {
    return <div className="diff-line diff-line--empty" />;
  }
  const key = lineKeyMap.get(line);
  const html = key ? highlightedByKey?.[key] : undefined;
  return (
    <div
      className={`diff-line diff-line--${line.type}`}
      // Jump-to-line fix (CUJ 1a): only the new/right-side cell carries
      // `data-line`, matching the inline layout's convention, so the existing
      // scroll-to-line query in FilePreviewPane keeps working unchanged.
      data-line={isNewSide ? (line.newLineNumber ?? undefined) : undefined}
    >
      <span className="diff-gutter">{isNewSide ? (line.newLineNumber ?? "") : (line.oldLineNumber ?? "")}</span>
      <span className="diff-marker">{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
      <span
        className={`diff-line-text diff-line-text--${line.type}${html ? " diff-line-text--shiki" : ""}`}
        dangerouslySetInnerHTML={{ __html: html ?? escapeHtml(line.content) }}
      />
    </div>
  );
}

/** Presentational two-column side-by-side diff render, split out of
 *  `DiffView.tsx` to keep that file under the repo's size guardrail
 *  (plan Decision 6). Not `interactive`-aware itself — renders exactly what
 *  `DiffView` hands it via props. */
export function DiffSideBySide({
  hunks,
  collapsedHunks,
  lineKeyMap,
  highlightedByKey,
  onToggleHunk,
  onHunkMouseEnter,
  onHunkMouseLeave,
  registerHeaderRef,
  gaps,
  expandedGaps,
  fileLines,
  onToggleGap,
}: DiffSideBySideProps) {
  const renderGap = (gap: DiffGap) => {
    const expanded = expandedGaps.has(gap.id);
    return (
      <div key={gap.id} className="preview-diff-side-by-side__gap">
        <button
          type="button"
          className="preview-diff-gap-header"
          aria-expanded={expanded}
          aria-label={
            expanded ? `Collapse ${gap.lineCount} hidden lines` : `Expand ${gap.lineCount} hidden lines`
          }
          onClick={() => onToggleGap(gap.id)}
        >
          <span className="preview-diff-gap-caret">{expanded ? "▾" : "⋯"}</span>
          {expanded ? null : (
            <span className="preview-diff-gap-label">{`${gap.lineCount} lines hidden — click to expand`}</span>
          )}
        </button>
        {expanded
          ? fileLines!.slice(gap.startLine - 1, gap.endLine).map((content, k) => {
              const lineNumber = gap.startLine + k;
              const oldLineNumber = lineNumber + gap.oldOffset;
              const text = (
                <span
                  className="diff-line-text diff-line-text--context"
                  dangerouslySetInnerHTML={{ __html: escapeHtml(content) }}
                />
              );
              return (
                <Fragment key={`${gap.id}-${k}`}>
                  <div className="diff-line diff-line--context">
                    <span className="diff-gutter">{oldLineNumber}</span>
                    <span className="diff-marker"> </span>
                    {text}
                  </div>
                  {/* Only the new/right-side cell carries `data-line`, matching
                   *  the same convention `renderCell` above uses — that's what
                   *  `FilePreviewPane`'s jump-to-line query relies on. */}
                  <div className="diff-line diff-line--context" data-line={lineNumber}>
                    <span className="diff-gutter">{lineNumber}</span>
                    <span className="diff-marker"> </span>
                    {text}
                  </div>
                </Fragment>
              );
            })
          : null}
      </div>
    );
  };

  const gapEnd = gaps.find((g) => g.id === "gap-end");

  return (
    <div className="preview-diff-side-by-side">
      {hunks.map((hunk, i) => {
        const collapsed = collapsedHunks.has(i);
        const rows = collapsed ? [] : pairHunkLines(hunk.lines, i);
        const gapBefore = gaps.find((g) => (i === 0 ? g.id === "gap-start" : g.id === `gap-${i - 1}`));
        return (
          <Fragment key={i}>
            {gapBefore ? renderGap(gapBefore) : null}
            <div
              className="preview-diff-side-by-side__hunk"
              onMouseEnter={() => onHunkMouseEnter(i)}
              onMouseLeave={() => onHunkMouseLeave(i)}
            >
              <div className="preview-diff-hunk-header" ref={(el) => registerHeaderRef(i, el)}>
                <button
                  type="button"
                  className="preview-diff-hunk-caret"
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? "Expand hunk" : "Collapse hunk"}
                  onClick={() => onToggleHunk(i)}
                >
                  {collapsed ? "▸" : "▾"}
                </button>
                <span>{hunk.header}</span>
              </div>
              {collapsed ? (
                <div className="preview-diff-hunk-collapsed">{`${hunk.header} — ${hunk.lines.length} lines collapsed`}</div>
              ) : (
                rows.map((row) => (
                  <Fragment key={row.key}>
                    {renderCell(row.left, lineKeyMap, highlightedByKey, false)}
                    {renderCell(row.right, lineKeyMap, highlightedByKey, true)}
                  </Fragment>
                ))
              )}
            </div>
          </Fragment>
        );
      })}
      {gapEnd ? renderGap(gapEnd) : null}
    </div>
  );
}
