import { useCallback, useMemo } from "react";
import type { ReviewComment } from "@/api/types";
import { isHtmlPath } from "@/components/preview/htmlDocument";
import { focusCommentCard } from "./commentJump";
import type { CommentSurfaceValue } from "./CommentSurfaceContext";
import { useCommentSurface } from "./CommentSurfaceContext";
import type { PinMeasurer } from "./pinMeasurer";
import { commentSpan, type SurfaceComments } from "./rowIndex";

export interface CodeCommentProps {
  covers?: readonly ReviewComment[];
  pins?: readonly ReviewComment[];
  /** The open box's span when it covers this row (dashed marks; its pin sits on the span's last row). */
  draft?: ReviewComment;
  /** Id of the comment being edited (its pin gets the active ring). */
  activeId?: string | null;
  measurer?: PinMeasurer;
  onPlus: (plus: HTMLElement) => void;
  pinLabel: (c: ReviewComment) => string;
  onPinOpen: (id: string, el: HTMLElement) => void;
}

export interface CodeComments {
  surface: CommentSurfaceValue;
  view: SurfaceComments;
  /** Lines the virtualiser must keep mounted: the one under the open box. */
  pinnedLines: number[];
  lineProps: (lineNum: number) => CodeCommentProps;
}

/**
 * `CodeView`'s window onto the comment surface: per-line covers / pins / `+` handler, and the lines to pin in
 * the virtualiser. Null outside a comment surface, for a different file, or when the gutter is off.
 */
export function useCodeComments(filePath: string | undefined, gutter: boolean): CodeComments | null {
  const cs = useCommentSurface();
  const active = gutter && !!cs && cs.enabled && filePath === cs.path;
  const surfaceName = filePath && isHtmlPath(filePath) ? "html-source" : "file";
  const view = active ? cs.forSurface(surfaceName) : null;
  const open = active ? cs.open : null;

  const onPlus = useCallback(
    (plus: HTMLElement) => {
      const row = plus.closest<HTMLElement>(".workspace-code-line");
      const anchor = row && cs ? cs.describeRowEl(row) : null;
      if (anchor && cs) cs.openNew(anchor, { returnFocus: plus });
    },
    [cs],
  );

  const pinnedLines = useMemo(() => {
    if (open?.kind === "new" && open.anchor.surface === surfaceName) {
      const n = open.anchor.lineEnd ?? open.anchor.lineStart;
      return n != null ? [n] : [];
    }
    if (open?.kind === "edit" && open.snapshot.surface === surfaceName) {
      const span = commentSpan(open.snapshot);
      return span ? [span.end] : [];
    }
    return [];
  }, [open, surfaceName]);

  return useMemo(() => {
    if (!cs || !view || !active) return null;
    const keyOf = (n: number) => `new:${n}`;
    const draft = cs.draft?.surface === surfaceName ? cs.draft : null;
    const draftSpan = draft ? commentSpan(draft) : null;
    return {
      surface: cs,
      view,
      pinnedLines,
      lineProps: (n) => ({
        covers: view.covers.get(keyOf(n)),
        pins: view.ends.get(keyOf(n)),
        draft: draft && draftSpan && draftSpan.start <= n && n <= draftSpan.end ? draft : undefined,
        activeId: cs.activeId,
        measurer: cs.pinMeasurer,
        onPlus,
        pinLabel: cs.pinLabel,
        onPinOpen: focusCommentCard,
      }),
    };
  }, [cs, view, active, pinnedLines, onPlus, surfaceName]);
}
