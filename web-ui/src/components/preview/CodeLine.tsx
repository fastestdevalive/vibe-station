import { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import { markRangeInElement } from "@/lib/markRange";
import type { ReviewComment } from "@/api/types";
import { PinGutter } from "@/components/comments/CommentPins";
import { commentSpan } from "@/components/comments/rowIndex";
import type { PinMeasurer } from "@/components/comments/pinMeasurer";
import { usePinHost, useRowPinTargets } from "@/components/comments/usePinHost";
import { markHtmlRanges, markPlainRanges } from "@/components/comments/markHtmlRanges";
import { rowMarks } from "@/components/comments/rowIndex";
import type { GutterMarkKind } from "./CodeView";

export interface CodeLineProps {
  line: string;
  lineNum: number;
  /** Pre-rendered Shiki HTML for this line; `undefined` → escapeHtml fallback. */
  html: string | undefined;
  /** Git gutter kinds for this line — each becomes a `workspace-code-line--{kind}` modifier. */
  gutterMark: ReadonlySet<GutterMarkKind> | undefined;
  isTarget: boolean;
  /** `[markStart, markEnd)` column span to mark on the target line (see
   *  `targetMatchSpan`). Primitives, not an object, so `memo` stays effective. */
  markStart?: number;
  markEnd?: number;
  noGutter?: boolean;
  /** Gutter width in `ch` units (digits of the last line number). */
  gutterWidth: number;
  /** Review comments covering this line (row highlight + text marks); undefined when commenting is off. */
  covers?: readonly ReviewComment[];
  /** Comments whose last line this is (pins). */
  pins?: readonly ReviewComment[];
  /** The open box's span when it covers this line (dashed marks; draft pin on its last line). */
  draft?: ReviewComment;
  /** Id of the comment being edited (its pin gets the active ring). */
  activeId?: string | null;
  /** Places this row's pins in the right gutter (absent when commenting is off). */
  measurer?: PinMeasurer;
  /** Show the gutter `+`; called with the button so focus can return to it. */
  onPlus?: (plus: HTMLElement) => void;
  pinLabel?: (c: ReviewComment) => string;
  onPinOpen?: (id: string, el: HTMLElement) => void;
}

/**
 * A single code-viewer line row, memoized so a settled row does not re-render
 * when an unrelated row (or the scroll container) changes. Extracted verbatim
 * from `CodeView`'s per-line render.
 */
export const CodeLine = memo(function CodeLine({
  line,
  lineNum,
  html,
  gutterMark,
  isTarget,
  markStart,
  markEnd,
  noGutter,
  gutterWidth,
  covers,
  pins,
  draft,
  activeId,
  measurer,
  onPlus,
  pinLabel,
  onPinOpen,
}: CodeLineProps) {
  let gutterClass = "";
  if (gutterMark) {
    for (const kind of gutterMark) gutterClass += ` workspace-code-line--${kind}`;
  }
  const commented = covers && covers.length > 0;
  const modifierClass = `${gutterClass}${isTarget ? " workspace-code-line--target" : ""}${commented ? " workspace-code-line--commented" : ""}`;
  // Comment text marks go into the Shiki HTML (never wrapped around React-owned DOM afterwards).
  const marks = useMemo(
    () => rowMarks(draft ? [...(covers ?? []), draft] : covers, line, lineNum),
    [covers, draft, line, lineNum],
  );
  // Pins sit in the right gutter on the visual line of the quote's last character (measured, never inline).
  const hostRef = useRef<HTMLDivElement>(null);
  const draftEnds = draft && commentSpan(draft)?.end === lineNum ? draft : undefined;
  const targets = useRowPinTargets(pins, draftEnds, activeId, line, pinLabel);
  const trackStack = useCallback((el: HTMLElement) => measurer!.trackStack(el), [measurer]);
  const placements = usePinHost(measurer, hostRef, ".workspace-code-content", targets, html);
  const markedHtml = useMemo(
    () => (marks.length === 0 ? html : html !== undefined ? markHtmlRanges(html, marks) : markPlainRanges(line, marks)),
    [marks, html, line],
  );
  const wantsMatchMark = isTarget && markStart != null && markEnd != null && markEnd > markStart;
  // Stable per span so React doesn't detach/re-attach the ref each render.
  const markRef = useCallback(
    (el: HTMLElement | null) => {
      if (el && markStart != null && markEnd != null) {
        markRangeInElement(el, markStart, markEnd - markStart, "workspace-code-match");
      }
    },
    // `html` so a re-rendered innerHTML (approximate → exact pass) re-marks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markStart, markEnd, html],
  );
  let content: ReactNode;
  if (markedHtml !== undefined) {
    content = (
      <span
        key={wantsMatchMark ? `shiki-marked-${markStart}-${markEnd}` : "shiki"}
        className="workspace-code-content workspace-code-content--shiki"
        dangerouslySetInnerHTML={{ __html: markedHtml }}
        ref={wantsMatchMark ? markRef : undefined}
      />
    );
  } else if (wantsMatchMark) {
    content = (
      <span className="workspace-code-content">
        {line.slice(0, markStart)}
        <mark className="workspace-code-match">{line.slice(markStart, markEnd)}</mark>
        {line.slice(markEnd)}
      </span>
    );
  } else {
    content = <span className="workspace-code-content">{line}</span>;
  }
  return (
    <div className={`workspace-code-line${modifierClass}`} data-line={lineNum} ref={hostRef}>
      {!noGutter && (
        <span className="workspace-code-gutter" style={{ minWidth: `${gutterWidth + 2}ch` }}>
          {lineNum}
          {onPlus ? (
            <button
              type="button"
              className="comment-plus"
              data-comment-plus
              tabIndex={-1}
              aria-label={`Add comment on line ${lineNum}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onPlus(e.currentTarget);
              }}
            />
          ) : null}
        </span>
      )}
      {content}
      <PinGutter placements={placements} targets={targets} onOpen={onPinOpen} trackStack={measurer ? trackStack : undefined} />
    </div>
  );
});
