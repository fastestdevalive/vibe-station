import { memo, useCallback, type ReactNode } from "react";
import { markRangeInElement } from "@/lib/markRange";
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
}: CodeLineProps) {
  let gutterClass = "";
  if (gutterMark) {
    for (const kind of gutterMark) gutterClass += ` workspace-code-line--${kind}`;
  }
  const modifierClass = `${gutterClass}${isTarget ? " workspace-code-line--target" : ""}`;
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
  if (html !== undefined) {
    content = (
      <span
        key={wantsMatchMark ? `shiki-marked-${markStart}-${markEnd}` : "shiki"}
        className="workspace-code-content workspace-code-content--shiki"
        dangerouslySetInnerHTML={{ __html: html }}
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
    <div className={`workspace-code-line${modifierClass}`} data-line={lineNum}>
      {!noGutter && (
        <span className="workspace-code-gutter" style={{ minWidth: `${gutterWidth + 2}ch` }}>
          {lineNum}
        </span>
      )}
      {content}
    </div>
  );
});
