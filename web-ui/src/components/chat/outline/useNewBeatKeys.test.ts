import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { TurnNode } from "./buildTurnOutline";
import type { Beat } from "./buildTurnBeats";
import { makeBeat } from "./outlineTestUtils";
import { useNewBeatKeys } from "./useNewBeatKeys";

function beat(key: string): Beat {
  return makeBeat(key, "text", key);
}

function liveTurn(beats: Beat[]): TurnNode {
  return {
    key: "t1",
    anchor: "u:t1",
    index: 0,
    turnKey: "t1",
    number: 1,
    label: "Turn 1",
    edits: 0,
    errors: 0,
    live: true,
    breakBefore: false,
    cancelled: false,
    beats,
  };
}

describe("useNewBeatKeys", () => {
  it("a live turn that loads after an empty first render is not flashed as new", () => {
    const { result, rerender } = renderHook(({ nodes }) => useNewBeatKeys(nodes), {
      initialProps: { nodes: [] as TurnNode[] },
    });
    rerender({ nodes: [liveTurn([beat("a"), beat("b")])] });
    expect(result.current.size).toBe(0);
  });

  it("a beat appended to the live turn after the first load is new", () => {
    const { result, rerender } = renderHook(({ nodes }) => useNewBeatKeys(nodes), {
      initialProps: { nodes: [] as TurnNode[] },
    });
    rerender({ nodes: [liveTurn([beat("a")])] });
    rerender({ nodes: [liveTurn([beat("a"), beat("b")])] });
    expect([...result.current]).toEqual(["b"]);
  });

  it("a newly settled turn's beats are registered once, never flashed as new", () => {
    const settled = (key: string, beats: Beat[]): TurnNode => ({
      ...liveTurn(beats),
      key,
      anchor: `u:${key}`,
      live: false,
    });
    const live = (beats: Beat[]): TurnNode => ({ ...liveTurn(beats), key: "t3", anchor: "u:t3" });
    const { result, rerender } = renderHook(({ nodes }) => useNewBeatKeys(nodes), {
      initialProps: { nodes: [] as TurnNode[] },
    });
    rerender({ nodes: [settled("t1", [beat("a")])] });
    rerender({ nodes: [settled("t1", [beat("a")]), settled("t2", [beat("c")]), live([beat("d")])] });
    // Only the new live turn's own beat flashes; the settled turn's beat never does.
    expect([...result.current]).toEqual(["d"]);
    rerender({
      nodes: [settled("t1", [beat("a")]), settled("t2", [beat("c")]), live([beat("d"), beat("e")])],
    });
    expect([...result.current].sort()).toEqual(["d", "e"]);
  });
});
