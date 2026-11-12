/**
 * Pure geometry of the turn chain: the chain is exactly as tall as the chat
 * viewport and every turn and step of the loaded chat sits at a y proportional
 * to its place in the flat row list (turn, its steps, next turn, ...).
 * Pure: no DOM, no React, no module state.
 */
import type { TurnNode } from "./buildTurnOutline";
import { rowOffsets } from "./outlineTree";

/** Height of the hatched cap that stands for turns not loaded yet. */
export const CHAIN_CAP_H = 12;
/** Gap between the cap and the first row. */
export const CHAIN_CAP_GAP = 4;
/** At or above this row pitch every turn and step gets its own line. */
const ALL_ROWS_MIN_PITCH = 3;
/** Below this turn pitch turns merge into density buckets. */
const TURN_MIN_PITCH = 2;
/** Height of one density bucket. */
export const BUCKET_PX = 3;

/** One row of the flat list: a turn (`beat: null`) or one of its steps. */
export interface ChainRow {
  turn: number;
  beat: number | null;
}

/** Every turn followed by all of its steps, in chat order. */
export function chainRows(nodes: readonly TurnNode[]): ChainRow[] {
  const rows: ChainRow[] = [];
  nodes.forEach((n, turn) => {
    rows.push({ turn, beat: null });
    for (let beat = 0; beat < n.beats.length; beat++) rows.push({ turn, beat });
  });
  return rows;
}

/** `starts[i]` is the flat index of turn `i`'s row; `starts[nodes.length]` is the row count. */
export function turnRowStarts(nodes: readonly TurnNode[]): number[] {
  return rowOffsets(nodes, 1, 1);
}

/** The vertical band rows are spread over: below the cap when older turns are not loaded. */
export interface ChainTrack {
  top: number;
  height: number;
  rows: number;
}

export function chainTrack(height: number, rows: number, hasMore: boolean): ChainTrack {
  const top = hasMore ? CHAIN_CAP_H + CHAIN_CAP_GAP : 0;
  return { top, height: Math.max(0, height - top), rows: Math.max(0, rows) };
}

function rowPitch(track: ChainTrack): number {
  return track.rows > 0 ? track.height / track.rows : 0;
}

/** Centre y of flat row `i`. */
export function rowCenterY(track: ChainTrack, i: number): number {
  return track.top + (i + 0.5) * rowPitch(track);
}

/** Flat row under `y` (relative to the chain top), clamped to the ends; -1 with no rows. */
export function yToRow(track: ChainTrack, y: number): number {
  if (track.rows === 0) return -1;
  const pitch = rowPitch(track);
  if (pitch <= 0) return 0;
  const i = Math.floor((y - track.top) / pitch);
  return Math.min(track.rows - 1, Math.max(0, i));
}

export type ChainDensity = "all" | "turns" | "buckets";

/** Every row when rows are >= 3px apart; else turn lines only; turns under 2px apart merge into buckets. */
export function chainDensity(track: ChainTrack, turnCount: number): ChainDensity {
  if (rowPitch(track) >= ALL_ROWS_MIN_PITCH) return "all";
  if (turnCount > 0 && track.height / turnCount >= TURN_MIN_PITCH) return "turns";
  return "buckets";
}

export type ChainMarkKind =
  | "turn"
  | "turnIn"
  | "turnReview"
  | "turnErr"
  | "turnLive"
  | "step"
  | "stepErr"
  | "stepAsk"
  | "brk"
  | "hit"
  | "hitCur"
  | "hitPeek";

export type ChainMarks = Record<ChainMarkKind, number[]>;

export interface ChainMarkOpts {
  /** Turn indices overlapping the chat viewport. */
  visibleTurns: ReadonlySet<number>;
  /** Turn anchors with find hits, the current hit's turn, the peeked turn. */
  hitTurns?: ReadonlySet<string>;
  currentTurn?: string;
  peekTurn?: string;
}

const TURN_PRIORITY: ChainMarkKind[] = ["turnLive", "turnErr", "turnReview", "turnIn", "turn"];

function turnKind(n: TurnNode, inView: boolean): ChainMarkKind {
  if (n.live) return "turnLive";
  if (n.errors > 0) return "turnErr";
  if (n.review) return "turnReview";
  return inView ? "turnIn" : "turn";
}

function emptyMarks(): ChainMarks {
  return {
    turn: [], turnIn: [], turnReview: [], turnErr: [], turnLive: [],
    step: [], stepErr: [], stepAsk: [], brk: [], hit: [], hitCur: [], hitPeek: [],
  };
}

/**
 * The y of every mark by kind, after the density rule. Ys are whole pixels;
 * each kind's list is de-duplicated so a dense chain never stacks lines.
 */
export function chainMarks(nodes: readonly TurnNode[], track: ChainTrack, opts: ChainMarkOpts): ChainMarks {
  const sets = new Map<ChainMarkKind, Set<number>>();
  const add = (kind: ChainMarkKind, y: number) => {
    let s = sets.get(kind);
    if (!s) sets.set(kind, (s = new Set()));
    s.add(y);
  };
  const density = chainDensity(track, nodes.length);
  const starts = turnRowStarts(nodes);
  const pitch = rowPitch(track);
  const yOf = (row: number) => Math.round(rowCenterY(track, row));
  const lastBucket = Math.max(0, Math.ceil(track.height / BUCKET_PX) - 1);
  /** Centre of the bucket holding flat row `row` (bucketed on the exact centre, not the rounded one). */
  const bucketOf = (row: number) => {
    const b = Math.min(lastBucket, Math.floor((rowCenterY(track, row) - track.top) / BUCKET_PX));
    return Math.round(track.top + (b + 0.5) * BUCKET_PX);
  };
  const bucketTurn = new Map<number, ChainMarkKind>();

  nodes.forEach((n, i) => {
    const y = yOf(starts[i]!);
    const kind = turnKind(n, opts.visibleTurns.has(i));
    if (density === "buckets") {
      const b = bucketOf(starts[i]!);
      const prev = bucketTurn.get(b);
      if (!prev || TURN_PRIORITY.indexOf(kind) < TURN_PRIORITY.indexOf(prev)) bucketTurn.set(b, kind);
    } else {
      add(kind, y);
    }
    if (n.breakBefore && density !== "buckets") add("brk", Math.round(y - pitch / 2));
    if (opts.hitTurns?.has(n.anchor)) add("hit", y);
    if (opts.currentTurn === n.anchor) add("hitCur", y);
    else if (opts.peekTurn === n.anchor) add("hitPeek", y);

    n.beats.forEach((b, k) => {
      const notable = b.kind === "error" ? "stepErr" : b.kind === "ask" ? "stepAsk" : null;
      if (density === "all") {
        add(notable ?? "step", yOf(starts[i]! + 1 + k));
      } else if (notable) {
        const row = starts[i]! + 1 + k;
        add(notable, density === "buckets" ? bucketOf(row) : yOf(row));
      }
    });
  });

  for (const [y, kind] of bucketTurn) add(kind, y);
  const out = emptyMarks();
  for (const [kind, s] of sets) out[kind] = [...s].sort((a, b) => a - b);
  return out;
}

/** Top and height of the in-view band: from the first visible turn's row to the last visible turn's last step. */
export function inViewBand(
  nodes: readonly TurnNode[],
  track: ChainTrack,
  visibleTurns: ReadonlySet<number>,
): { top: number; height: number } | null {
  if (visibleTurns.size === 0 || track.rows === 0) return null;
  let first = Infinity;
  let last = -Infinity;
  for (const t of visibleTurns) {
    if (t < 0 || t >= nodes.length) continue;
    first = Math.min(first, t);
    last = Math.max(last, t);
  }
  if (first === Infinity) return null;
  const starts = turnRowStarts(nodes);
  const pitch = rowPitch(track);
  const top = track.top + starts[first]! * pitch;
  const bottom = track.top + starts[last + 1]! * pitch;
  // A band thinner than a few pixels would vanish; centre a 4px minimum on it.
  const height = Math.max(4, bottom - top);
  return { top: Math.round(Math.max(0, top - (height - (bottom - top)) / 2)), height: Math.round(height) };
}
