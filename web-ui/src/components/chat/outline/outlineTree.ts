/**
 * Pure functions for outline navigation and geometry. Every turn's steps are always
 * listed under it, so the outline is one flat run of rows: turn, its steps, next turn, …
 * Pure: no DOM, no React, no module state.
 */
import type { TurnNode } from "./buildTurnOutline";

export interface TreeFocus {
  turnKey: string;
  beat: number | null;
}

/** How the outline was opened: a press still held, a wheel scrub, a tap (sticky list) or the keyboard. */
export type PanelMode = "scrub" | "wheel" | "sticky" | "keyboard";

/**
 * Prefix sums of row heights: `offsets[i]` is the top of turn `i`, `offsets[nodes.length]`
 * the total height. Heights are deterministic (`turnH + beats * beatH`).
 */
export function rowOffsets(nodes: readonly TurnNode[], turnH: number, beatH: number): number[] {
  const offsets = new Array<number>(nodes.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < nodes.length; i++) {
    offsets[i + 1] = offsets[i]! + turnH + nodes[i]!.beats.length * beatH;
  }
  return offsets;
}

/** Rows the outline renders for `nodes`: one per turn plus one per step. */
export function outlineRowCount(nodes: readonly TurnNode[]): number {
  return rowOffsets(nodes, 1, 1)[nodes.length]!;
}

export function currentTurnIndex(visibleTurnIndices: Set<number>, n: number): number {
  if (visibleTurnIndices.size > 0) {
    let minIdx = Infinity;
    for (const idx of visibleTurnIndices) {
      if (idx < minIdx) minIdx = idx;
    }
    if (minIdx !== Infinity && minIdx < n) {
      return minIdx;
    }
  }
  return Math.max(0, n - 1);
}

/**
 * The row ↑ / ↓ / Home / End move to from `focus` over the flat run of rows in `list`
 * (clamped at both ends); `null` for any other key or an empty list. A focus whose turn
 * is not in `list` lands on the first row.
 */
export function outlineKeyNav(focus: TreeFocus, key: string, list: readonly TurnNode[]): TreeFocus | null {
  if (list.length === 0) return null;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return null;

  const first: TreeFocus = { turnKey: list[0]!.key, beat: null };
  const lastNode = list[list.length - 1]!;
  const last: TreeFocus = {
    turnKey: lastNode.key,
    beat: lastNode.beats.length > 0 ? lastNode.beats.length - 1 : null,
  };
  if (key === "Home") return first;
  if (key === "End") return last;

  const idx = list.findIndex((n) => n.key === focus.turnKey);
  if (idx === -1) return first;
  const node = list[idx]!;
  const k = focus.beat;

  if (key === "ArrowDown") {
    const nextBeat = k == null ? 0 : k + 1;
    if (nextBeat < node.beats.length) return { turnKey: node.key, beat: nextBeat };
    const next = list[idx + 1];
    return next ? { turnKey: next.key, beat: null } : { turnKey: node.key, beat: k };
  }

  // ArrowUp
  if (k != null) return { turnKey: node.key, beat: k > 0 ? k - 1 : null };
  const prev = list[idx - 1];
  if (!prev) return { turnKey: node.key, beat: null };
  return { turnKey: prev.key, beat: prev.beats.length > 0 ? prev.beats.length - 1 : null };
}

/** DOM id of an outline row; `outlineId` keeps it unique per chat pane. */
export function outlineRowId(outlineId: string, key: string): string {
  return `${outlineId}-row-${key}`;
}

/** DOM id of a beat within a turn; suffixed with -b{k}. */
export function outlineBeatId(outlineId: string, turnKey: string, k: number): string {
  return `${outlineRowId(outlineId, turnKey)}-b${k}`;
}
