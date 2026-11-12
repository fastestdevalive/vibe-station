import { useCallback, useEffect, useMemo, type RefObject } from "react";
import type { GutterMarkKind, CodeViewHandle } from "@/components/preview/CodeView";
import type { DiffHunk } from "@/preview/diffParser";
import { useCodeComments } from "@/components/comments/useCodeComments";
import { commentSpan } from "@/components/comments/rowIndex";
import { ScrollMap } from "./ScrollMap";
import type { EffectiveScrollMap } from "./effectiveScrollMapMode";
import { scrollToLine } from "./codeLines";

export interface PreviewScrollMapProps {
  scrollEl: HTMLElement | null;
  path: string;
  viewScope: "none" | "local" | "branch" | "commit";
  diffBody: string | null;
  /** The hunks the diff view renders (`previewDiffHunks`). */
  previewHunks: DiffHunk[];
  fileBody: string | null;
  showHtmlRendered: boolean;
  isMd: boolean;
  isImage: boolean;
  gutterMarks: Map<number, ReadonlySet<GutterMarkKind>> | null;
  effectiveLine: number | null;
  codeViewRef: RefObject<CodeViewHandle | null>;
  onDisplayChange?: (display: EffectiveScrollMap | null) => void;
}

const NO_HUNKS: DiffHunk[] = [];

/** Line count of `text` as `split(/\r?\n/)` would give it, without building the array. */
function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

export function PreviewScrollMap({
  scrollEl,
  path,
  viewScope,
  diffBody,
  previewHunks,
  fileBody,
  showHtmlRendered,
  isMd,
  isImage,
  gutterMarks,
  effectiveLine,
  codeViewRef,
  onDisplayChange,
}: PreviewScrollMapProps) {
  const isDiff = viewScope === "local" || viewScope === "branch" || viewScope === "commit";
  const isCode = !isDiff && !!fileBody && !showHtmlRendered && !isMd && !isImage && viewScope === "none";

  useEffect(() => {
    if (!isDiff && !isCode) {
      onDisplayChange?.(null);
    }
  }, [isDiff, isCode, onDisplayChange]);

  useEffect(() => {
    return () => {
      onDisplayChange?.(null);
    };
  }, [onDisplayChange]);

  const diffText = diffBody ?? "";
  // The same hunks DiffView renders, so an untracked file (no diff text) still
  // gets a thumb and marks on its synthetic all-added hunk.
  const hunks = useMemo(() => (isDiff ? previewHunks : NO_HUNKS), [isDiff, previewHunks]);

  const diffRowCount = useMemo(() => {
    return hunks.reduce((acc, h) => acc + h.lines.length, 0);
  }, [hunks]);

  const codeComments = useCodeComments(path, true);
  const commentLines = useMemo(() => {
    if (!codeComments?.view.list) return [];
    const ranges: Array<[number, number]> = [];
    for (const c of codeComments.view.list) {
      const span = commentSpan(c);
      if (span) {
        ranges.push([span.start, span.end]);
      }
    }
    return ranges;
  }, [codeComments]);

  const fileLineCount = useMemo(() => (fileBody ? countLines(fileBody) : 0), [fileBody]);

  const handleCodeJump = useCallback(
    (line: number) => {
      if (scrollEl) {
        scrollToLine(scrollEl, codeViewRef.current, line);
      }
    },
    [scrollEl, codeViewRef],
  );

  const handleDiffJump = useCallback(
    (line: number) => {
      if (!scrollEl) return;
      // `line` is a 1-based diff ROW index (the scale marks are built on — see
      // `buildDiffMarks`), not a new-file line number, so it is matched against
      // `data-diff-row`, which DiffView/DiffSideBySide put on every rendered row.
      const row = scrollEl.querySelector<HTMLElement>(`.diff-line[data-diff-row="${line}"]`);
      if (row) {
        row.scrollIntoView({ block: "start" });
        return;
      }
      // The row is not rendered: its hunk is collapsed (or it is the far cell
      // of a side-by-side pair, which carries its pair's representative index).
      // Scroll the owning hunk into view instead.
      let currentLine = 1;
      for (let i = 0; i < hunks.length; i++) {
        const hunk = hunks[i];
        if (!hunk) continue;
        const count = hunk.lines.length;
        if (line >= currentLine && line < currentLine + count) {
          const hunkEls = scrollEl.querySelectorAll<HTMLElement>(
            ".preview-diff-hunk, .preview-diff-side-by-side__hunk",
          );
          hunkEls[i]?.scrollIntoView({ block: "start" });
          return;
        }
        currentLine += count;
      }
    },
    [scrollEl, hunks],
  );

  if (isDiff) {
    return (
      <ScrollMap
        scrollEl={scrollEl}
        mode="diff"
        code={diffText.trim() ? diffText : (fileBody ?? "")}
        lineCount={diffRowCount}
        diffHunks={hunks}
        onJump={handleDiffJump}
        onDisplayChange={onDisplayChange}
      />
    );
  }

  if (isCode) {
    return (
      <ScrollMap
        scrollEl={scrollEl}
        mode="code"
        code={fileBody}
        lineCount={fileLineCount}
        gutter={gutterMarks}
        commentLines={commentLines}
        targetLine={effectiveLine}
        onJump={handleCodeJump}
        onDisplayChange={onDisplayChange}
      />
    );
  }

  return null;
}
