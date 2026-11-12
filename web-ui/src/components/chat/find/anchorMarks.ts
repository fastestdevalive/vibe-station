/**
 * Helpers for selecting and grouping find hit marks within a rendered anchor row.
 */

/** Selector matching `<mark>` elements inside `anchor` that belong to it. */
function anchorMarkSelector(anchor: string): string {
  const a = CSS.escape(anchor);
  return `mark.find-hit[data-find-key^="${a}/"], mark.find-hit[data-find-key^="${a}:"], mark.find-hit[data-find-key="${a}"]`;
}

interface GroupedAnchorMarks {
  distinctKeys: string[];
  keyMarks: Map<string, HTMLElement[]>;
  keyFirstMark: Map<string, HTMLElement>;
}

export function groupAnchorMarks(container: ParentNode, anchor: string): GroupedAnchorMarks {
  const marks = container.querySelectorAll<HTMLElement>(anchorMarkSelector(anchor));
  const distinctKeys: string[] = [];
  const keyMarks = new Map<string, HTMLElement[]>();
  const keyFirstMark = new Map<string, HTMLElement>();

  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const k = m.getAttribute("data-find-key");
    if (!k) continue;

    let list = keyMarks.get(k);
    if (!list) {
      distinctKeys.push(k);
      keyFirstMark.set(k, m);
      keyMarks.set(k, (list = []));
    }
    list.push(m);
  }

  return { distinctKeys, keyMarks, keyFirstMark };
}
