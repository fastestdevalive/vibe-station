import { surfaceText, surfaceTextPos } from "./surfaceText";

/** Pin diameter in CSS px (`--comment-pin-size`): 18 for a fine pointer (under a code line's height, so pins on
 * adjacent lines stay apart), 22 for a coarse one. */
export const PIN_SIZE = 18;
export const PIN_SIZE_COARSE = 22;
/** Pins closer than this (centre to centre) merge into one stack; coarse pointers keep a 24px target spacing. */
export const MERGE_DISTANCE = PIN_SIZE;
export const MERGE_DISTANCE_COARSE = 24;

export function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

export const pinSize = (coarse: boolean): number => (coarse ? PIN_SIZE_COARSE : PIN_SIZE);
export const mergeDistance = (coarse: boolean): number => (coarse ? MERGE_DISTANCE_COARSE : MERGE_DISTANCE);

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

function lastGrapheme(s: string): { index: number } {
  const Seg = (Intl as { Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment: (s: string) => Iterable<{ index: number }> } }).Segmenter;
  if (Seg) {
    let last = { index: 0 };
    for (const g of new Seg(undefined, { granularity: "grapheme" }).segment(s)) last = g;
    return last;
  }
  // No Segmenter: the last code point.
  const cps = [...s];
  return { index: s.length - (cps[cps.length - 1]?.length ?? 0) };
}

/**
 * A range over the LAST visible grapheme before column `endCol` of `textEl`'s comment text (never collapsed: a
 * collapsed range at a soft-wrap offset reports rects on both visual lines). Trailing whitespace is skipped
 * (it hangs or collapses at a wrap), and a ZWJ emoji / flag / combining sequence is one unit. Null when there
 * is no visible character.
 */
export function endCharRange(textEl: Element, endCol: number): Range | null {
  const text = surfaceText(textEl);
  let k = Math.min(endCol, text.length);
  while (k > 0 && /\s/.test(text[k - 1]!)) k--;
  if (k === 0) return null;
  const from = Math.max(0, k - 16);
  const last = lastGrapheme(text.slice(from, k));
  const a = surfaceTextPos(textEl, from + last.index, "forward");
  const b = surfaceTextPos(textEl, k, "backward");
  if (!a || !b) return null;
  const r = textEl.ownerDocument.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

/** Vertical centre of the LAST client rect (logical order = the last visual line; RTL-safe), or null. */
export function lineCenterY(src: Range | Element): number | null {
  if (typeof src.getClientRects !== "function") return null;
  const rects = [...src.getClientRects()].filter((x) => x.height > 0);
  const x = rects[rects.length - 1];
  return x ? x.top + x.height / 2 : null;
}

function snapToDevicePx(v: number): number {
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  return Math.round(v * dpr) / dpr;
}

/**
 * `top` (px, inside `host`) of a pin whose centre sits on the visual line of the end point. The end point is
 * `endEl` (markdown: the comment's last `<mark>` or fallback block), else the last character before `endCol`,
 * else (`endCol` null: blank / outdated row) the last visual line of the row's text, else the first line.
 * Pure reads; the result is clamped inside the host.
 */
export function measurePin(
  host: HTMLElement,
  textEl: HTMLElement,
  endCol: number | null,
  pin: number,
  endEl?: Element,
): number {
  const hostTop = host.getBoundingClientRect().top;
  let src: Range | Element | null = null;
  if (endEl) {
    // A mark's rects are its lines; a fallback block's own box is the whole block, so use its last line.
    if (endEl.matches("mark")) src = endEl;
    else {
      src = endEl.ownerDocument.createRange();
      src.selectNodeContents(endEl);
    }
  }
  if (!src && endCol != null) src = endCharRange(textEl, endCol);
  if (!src && endCol === null) {
    const all = textEl.ownerDocument.createRange();
    all.selectNodeContents(textEl);
    src = all;
  }
  let cy = src ? lineCenterY(src) : null;
  if (cy == null) {
    const lh = parseFloat(getComputedStyle(textEl).lineHeight) || 20;
    cy = textEl.getBoundingClientRect().top + lh / 2;
  }
  const top = cy - hostTop - pin / 2;
  return clamp(snapToDevicePx(top), 0, Math.max(0, host.clientHeight - pin));
}

export interface PinPlacement {
  /** Top of the stack inside the host, px. */
  top: number;
  /** Member comment ids, in pin-number order. */
  ids: string[];
}

/**
 * Group pins whose tops are closer than `distance`: sorted by top, a pin joins the open group while
 * `top - group.top < distance`. The group sits at its first member's top; members are ordered by pin number.
 */
export function groupPins(items: ReadonlyArray<{ id: string; pin: number; top: number }>, distance: number): PinPlacement[] {
  const sorted = [...items].sort((a, b) => a.top - b.top || a.pin - b.pin);
  const groups: Array<{ top: number; members: typeof sorted }> = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && it.top - g.top < distance) g.members.push(it);
    else groups.push({ top: it.top, members: [it] });
  }
  return groups.map((g) => ({ top: g.top, ids: g.members.sort((a, b) => a.pin - b.pin).map((m) => m.id) }));
}

export function samePlacements(a: readonly PinPlacement[], b: readonly PinPlacement[]): boolean {
  return a.length === b.length && a.every((p, i) => p.top === b[i]!.top && p.ids.join("\u0000") === b[i]!.ids.join("\u0000"));
}
