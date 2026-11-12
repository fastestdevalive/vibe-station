import { describe, expect, it, vi } from "vitest";
import { loadUnloadedTurn, unloadedOwnerOf } from "./useChatOutline";
import type { OutlineSource } from "./outline/outlineSource";
import { makeBeat, makeTurn } from "./outline/outlineTestUtils";

describe("unloadedOwnerOf", () => {
  const unloaded = (i: number, anchors: string[] = []) => ({
    ...makeTurn(`n:${i}`, i + 1, ""),
    key: `n:${i}`,
    anchor: `n:${i}`,
    index: i,
    unloaded: true,
    beats: anchors.map((a) => ({ ...makeBeat(a, "text", a), anchor: a })),
  });
  const loaded = { ...makeTurn("t3", 3, "Turn 3"), index: 2, beats: [{ ...makeBeat("b", "text", "b"), anchor: "t:loaded" }] };
  const nodes = [unloaded(0), unloaded(1, ["t:step1", "i:item7"]), loaded];

  it("resolves the turn row of an unloaded turn", () => {
    expect(unloadedOwnerOf("n:0", nodes)).toBe(0);
  });

  it("resolves a step row of an unloaded turn to that turn", () => {
    expect(unloadedOwnerOf("t:step1", nodes)).toBe(1);
    expect(unloadedOwnerOf("i:item7", nodes)).toBe(1);
  });

  it("never claims a loaded turn's step, or an item anchor that merely looks like a turn key", () => {
    expect(unloadedOwnerOf("t:loaded", nodes)).toBeNull();
    expect(unloadedOwnerOf("i:1", nodes)).toBeNull();
    expect(unloadedOwnerOf("n:2", nodes)).toBeNull();
  });
});

describe("loadUnloadedTurn", () => {
  const source = (over: { fetchNow?: () => Promise<{ seq: number } | null>; viewAround?: () => Promise<void> }) =>
    ({
      windows: { turnAt: () => null, fetchNow: over.fetchNow ?? (async () => ({ seq: 7 })) },
      viewAround: over.viewAround ?? (async () => {}),
    }) as unknown as OutlineSource;

  it("returns the turn once the window has moved around it", async () => {
    const viewAround = vi.fn(async () => {});
    expect(await loadUnloadedTurn(source({ viewAround }), 3)).toEqual({ seq: 7 });
    expect(viewAround).toHaveBeenCalledWith(7);
  });

  it("is null when the turn cannot be fetched (the caller shows a failed state)", async () => {
    expect(await loadUnloadedTurn(source({ fetchNow: async () => null }), 3)).toBeNull();
  });

  it("is null when the window load rejects, never an unhandled rejection", async () => {
    const viewAround = vi.fn(async () => {
      throw new Error("500");
    });
    expect(await loadUnloadedTurn(source({ viewAround }), 3)).toBeNull();
  });
});
