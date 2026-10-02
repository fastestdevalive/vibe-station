/**
 * Wrap the character range `[offset, offset + length)` of `el`'s concatenated
 * text in one or more `<mark class={markClass}>` elements — split across text
 * nodes as needed, so Shiki's syntax-highlighting spans survive instead of
 * being flattened.
 *
 * Offsets are positional (a column), never an `indexOf` search: a line can
 * contain the same identifier several times, and only the occurrence the
 * language server pointed at is the right one to mark.
 *
 * Idempotent per element: a second call on an already-marked element is a
 * no-op (ref callbacks re-run on every render).
 */
export function markRangeInElement(
  el: HTMLElement,
  offset: number,
  length: number,
  markClass: string,
): void {
  if (offset < 0 || length <= 0) return;
  if (el.querySelector(`.${markClass}`)) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    textNodes.push(t);
    total += t.data.length;
  }
  const startIdx = offset;
  const endIdx = offset + length;
  if (endIdx > total) return;

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
    mark.className = markClass;
    target.replaceWith(mark);
    mark.appendChild(target);
  }
}
