import { memo, useCallback, type ReactNode } from "react";

export interface CodeLineProps {
  line: string;
  lineNum: number;
  /** Pre-rendered Shiki HTML for this line; `undefined` → escapeHtml fallback. */
  html: string | undefined;
  /** Git gutter modifier class fragment: `added`/`modified`/`deleted`. */
  gutterMark: "added" | "modified" | "deleted" | undefined;
  isTarget: boolean;
  matchText: string | undefined;
  noGutter?: boolean;
  /** Gutter width in `ch` units (digits of the last line number). */
  gutterWidth: number;
}

/** Wrap the first occurrence of `matchText` inside `el` with one or more
 *  `<mark class="workspace-code-match">` elements, preserving Shiki's
 *  syntax-highlighting spans instead of dropping them. */
function markMatchInElement(el: HTMLElement, matchText: string): void {
  if (!matchText) return;
  // Idempotent: already marked (e.g. ref re-ran on re-render) → don't nest.
  if (el.querySelector("mark.workspace-code-match")) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let concatenated = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    textNodes.push(t);
    concatenated += t.data;
  }
  const startIdx = concatenated.indexOf(matchText);
  if (startIdx < 0) return;
  const endIdx = startIdx + matchText.length;

  let pos = 0;
  for (const t of textNodes) {
    const len = t.data.length;
    const nodeStart = pos;
    const nodeEnd = pos + len;
    pos += len;
    const overlapStart = Math.max(startIdx, nodeStart);
    const overlapEnd = Math.min(endIdx, nodeEnd);
    if (overlapStart >= overlapEnd) continue;

    const localStart = overlapStart - nodeStart;
    const localEnd = overlapEnd - nodeStart;
    let target: Text = t;
    if (localStart > 0) target = target.splitText(localStart);
    if (localEnd - localStart < target.data.length) target.splitText(localEnd - localStart);

    const mark = document.createElement("mark");
    mark.className = "workspace-code-match";
    target.replaceWith(mark);
    mark.appendChild(target);
  }
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
  matchText,
  noGutter,
  gutterWidth,
}: CodeLineProps) {
  const modifierClass = `${gutterMark ? ` workspace-code-line--${gutterMark}` : ""}${isTarget ? " workspace-code-line--target" : ""}`;
  const wantsMatchMark = isTarget && !!matchText;
  // Stable per matchText so React doesn't detach/re-attach the ref each render.
  const markRef = useCallback(
    (el: HTMLElement | null) => {
      if (el && matchText) markMatchInElement(el, matchText);
    },
    // `html` so a re-rendered innerHTML (approximate → exact pass) re-marks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [matchText, html],
  );
  let content: ReactNode;
  if (html !== undefined) {
    content = (
      <span
        key={wantsMatchMark ? `shiki-marked-${matchText}` : "shiki"}
        className="workspace-code-content workspace-code-content--shiki"
        dangerouslySetInnerHTML={{ __html: html }}
        ref={wantsMatchMark ? markRef : undefined}
      />
    );
  } else if (wantsMatchMark) {
    const matchIdx = line.indexOf(matchText!);
    content =
      matchIdx >= 0 ? (
        <span className="workspace-code-content">
          {line.slice(0, matchIdx)}
          <mark className="workspace-code-match">{matchText}</mark>
          {line.slice(matchIdx + matchText!.length)}
        </span>
      ) : (
        <span className="workspace-code-content">{line}</span>
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
