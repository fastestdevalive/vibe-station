import { act, screen } from "@testing-library/react";
import type { TurnNode } from "./buildTurnOutline";
import type { Beat } from "./buildTurnBeats";
import type { RenderItem } from "../MessageList";
import type { MessageNav } from "../messageNav";

/** A nav stub for the chain: only the visible item range matters to it. */
export function fakeNav(range: [number, number] = [0, 0]): MessageNav {
  return { visibleItemRange: () => range } as unknown as MessageNav;
}

export function makeBeat(key: string, kind: Beat["kind"], label: string, count = 1): Beat {
  return { key, anchor: `t:${key}`, kind, label, count };
}

export function makeTurn(key: string, num: number, label: string): TurnNode {
  return {
    key,
    anchor: `u:${key}`,
    index: num - 1,
    turnKey: key,
    number: num,
    label,
    edits: 0,
    errors: 0,
    live: false,
    breakBefore: false,
    cancelled: false,
    beats: [],
  };
}

export function makeUserItem(turnId: string, text: string): RenderItem {
  return { type: "user", id: `u_${turnId}`, turnId, text };
}

/** `n` turns, each with `beats` text beats keyed `b{i}_{k}`, plus their user items. */
export function makeChat(n: number, beats = 0): { nodes: TurnNode[]; items: RenderItem[] } {
  const nodes: TurnNode[] = [];
  const items: RenderItem[] = [];
  for (let i = 1; i <= n; i++) {
    nodes.push({
      ...makeTurn(`t${i}`, i, `Turn ${i}`),
      beats: Array.from({ length: beats }, (_, k) => makeBeat(`b${i}_${k}`, "text", `Beat ${i}.${k}`)),
    });
    items.push(makeUserItem(`t${i}`, `Turn ${i}`));
  }
  return { nodes, items };
}

/** The outline row of turn `key` (row ids are unique per pane, suffixed by the node key). */
export function outlineRow(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#${CSS.escape(screen.getByRole("dialog").id)} [id$="-row-${key}"]`);
}

/** Resolves after the next animation frame, inside act. */
export async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
