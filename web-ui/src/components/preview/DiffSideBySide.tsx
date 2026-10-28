import { Fragment, useRef } from "react";
import type { DiffHunk, DiffLine } from "@/preview/diffParser";
import { pairHunkLines } from "@/preview/diffSideBySide";
import type { DiffGap } from "@/preview/diffGaps";
import { escapeHtml } from "./shikiHighlighter";
import { PinRow } from "@/components/comments/PinRow";
import { CommentRowStack } from "@/components/comments/CommentRows";
import { markHtmlRanges, markPlainRanges } from "@/components/comments/markHtmlRanges";
import { useColumnClamp } from "@/components/comments/useColumnClamp";
import { HunkCommentChip } from "@/components/comments/HunkCommentChip";
import type { DiffComments } from "@/components/comments/useDiffComments";
import type { RowSide } from "@/components/comments/rowIndex";

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
  /** Review comments for this file (null = commenting off). */
  comments?: DiffComments | null;
}

function renderCell(
  line: DiffLine | null,
  lineKeyMap: Map<DiffLine, string>,
  highlightedByKey: Record<string, string> | null,
  isNewSide: boolean,
  dc: DiffComments | null | undefined,
) {
  if (!line) {
    return <div className="diff-line diff-line--empty" />;
  }
  const key = lineKeyMap.get(line);
  const html = key ? highlightedByKey?.[key] : undefined;
  const side: RowSide = isNewSide ? "new" : "old";
  const n = isNewSide ? line.newLineNumber : line.oldLineNumber;
  const keys = dc && n != null ? [{ side, n }] : [];
  const covers = dc?.covers(keys);
  const pins = dc?.pins(keys);
  const marks = dc ? dc.marks(keys, line.content) : [];
  const shown = marks.length
    ? html !== undefined
      ? markHtmlRanges(html, marks)
      : markPlainRanges(line.content, marks)
    : (html ?? escapeHtml(line.content));
  return (
    <PinRow
      className={`diff-line diff-line--${line.type}${covers?.length ? " diff-line--commented" : ""}`}
      // Jump-to-line fix (CUJ 1a): only the new/right-side cell carries
      // `data-line`, matching the inline layout's convention, so the existing
      // scroll-to-line query in FilePreviewPane keeps working unchanged.
      data-line={isNewSide ? (line.newLineNumber ?? undefined) : undefined}
      // Comment anchoring (spike D1): every cell says which side it is and its old line.
      data-old-line={line.oldLineNumber ?? undefined}
      data-side={side}
      rowText={line.content}
      pins={pins}
      draft={dc?.draftEndsAt(keys)}
      activeId={dc?.activeId}
      measurer={dc?.measurer}
      pinLabel={dc?.surface.pinLabel}
      onPinOpen={dc?.onPinOpen}
      contentKey={shown}
    >
      <span className="diff-gutter">
        {n ?? ""}
        {dc && n != null ? (
          <button
            type="button"
            className="comment-plus"
            data-comment-plus
            tabIndex={-1}
            aria-label={`Add comment on ${side} line ${n}`}
            onClick={(e) => dc.onPlus(e.currentTarget)}
          />
        ) : null}
      </span>
      <span className="diff-marker">{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
      <span
        className={`diff-line-text diff-line-text--${line.type}${html || marks.length ? " diff-line-text--shiki" : ""}`}
        dangerouslySetInnerHTML={{ __html: shown }}
      />
    </PinRow>
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
  comments: dc,
}: DiffSideBySideProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useColumnClamp(rootRef);
  const renderGap = (gap: DiffGap) => {
    const expanded = expandedGaps.has(gap.id);
    return (
      <div key={gap.id} className="preview-diff-side-by-side__gap">
        <button
          type="button"
          className={`preview-diff-gap-header${!expanded && dc?.gapCommented(gap) ? " preview-diff-gap-header--commented" : ""}`}
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
                  <div className="diff-line diff-line--context" data-side="old" data-old-line={oldLineNumber}>
                    <span className="diff-gutter">{oldLineNumber}</span>
                    <span className="diff-marker"> </span>
                    {text}
                  </div>
                  {/* Only the new/right-side cell carries `data-line`, matching
                   *  the same convention `renderCell` above uses — that's what
                   *  `FilePreviewPane`'s jump-to-line query relies on. */}
                  <div className="diff-line diff-line--context" data-line={lineNumber} data-old-line={oldLineNumber} data-side="new">
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
    <div className="preview-diff-side-by-side" ref={rootRef}>
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
                <div className="preview-diff-hunk-collapsed">
                  {`${hunk.header} — ${hunk.lines.length} lines collapsed`}
                  <HunkCommentChip dc={dc} hunk={hunk} onExpand={() => onToggleHunk(i)} />
                </div>
              ) : (
                rows.map((row) => (
                  <Fragment key={row.key}>
                    {renderCell(row.left, lineKeyMap, highlightedByKey, false, dc)}
                    {renderCell(row.right, lineKeyMap, highlightedByKey, true, dc)}
                    {dc && row.left?.oldLineNumber != null ? (
                      <CommentRowStack surface={dc.surface} view={dc.view} side="old" n={row.left.oldLineNumber} />
                    ) : null}
                    {dc && row.right?.newLineNumber != null ? (
                      <CommentRowStack surface={dc.surface} view={dc.view} side="new" n={row.right.newLineNumber} />
                    ) : null}
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
