import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FADE_MS,
  reduceTransition,
  useWallpaperTransition,
  type TransitionState,
} from "./useWallpaperTransition";

const empty = (): TransitionState => ({ phase: "empty" });
const settled = (id: string): TransitionState => ({ phase: "settled", current: { id } });
const waiting = (current: string, incoming: string): TransitionState => ({
  phase: "waiting",
  current: { id: current },
  incoming: { id: incoming },
});
const fading = (current: string, incoming: string): TransitionState => ({
  phase: "fading",
  current: { id: current },
  incoming: { id: incoming },
});

describe("reduceTransition", () => {
  it("first paint settles without a fade", () => {
    expect(reduceTransition(empty(), { t: "target", id: "A" })).toEqual(settled("A"));
  });

  it("no target empties the layer", () => {
    const already = empty();
    expect(reduceTransition(already, { t: "target", id: null })).toBe(already);
    expect(reduceTransition(settled("A"), { t: "target", id: null })).toEqual(empty());
    expect(reduceTransition(waiting("A", "B"), { t: "target", id: null })).toEqual(empty());
    expect(reduceTransition(fading("A", "B"), { t: "target", id: null })).toEqual(empty());
  });

  it("same image never re-fades (same state object)", () => {
    const state = settled("A");
    expect(reduceTransition(state, { t: "target", id: "A" })).toBe(state);
  });

  it("a new image waits for its incoming picture", () => {
    expect(reduceTransition(settled("A"), { t: "target", id: "B" })).toEqual(waiting("A", "B"));
  });

  it("waiting: back to the current image abandons the incoming one", () => {
    expect(reduceTransition(waiting("A", "B"), { t: "target", id: "A" })).toEqual(settled("A"));
  });

  it("waiting: the incoming image is unchanged, a third one replaces it", () => {
    const state = waiting("A", "B");
    expect(reduceTransition(state, { t: "target", id: "B" })).toBe(state);
    expect(reduceTransition(state, { t: "target", id: "C" })).toEqual(waiting("A", "C"));
  });

  it("fading: a third target promotes the fading picture to current", () => {
    expect(reduceTransition(fading("A", "B"), { t: "target", id: "C" })).toEqual(waiting("B", "C"));
    expect(reduceTransition(fading("A", "B"), { t: "target", id: "A" })).toEqual(waiting("B", "A"));
  });

  it("fading: the incoming image is unchanged (no double fade)", () => {
    const state = fading("A", "B");
    expect(reduceTransition(state, { t: "target", id: "B" })).toBe(state);
  });

  it("ready fades the incoming picture in, or swaps instantly under reduced motion", () => {
    expect(reduceTransition(waiting("A", "B"), { t: "ready", id: "B" })).toEqual(fading("A", "B"));
    expect(reduceTransition(waiting("A", "B"), { t: "ready", id: "B" }, true)).toEqual(settled("B"));
  });

  it("ready ignores anything that is not the incoming picture", () => {
    expect(reduceTransition(waiting("A", "B"), { t: "ready", id: "A" })).toEqual(waiting("A", "B"));
    expect(reduceTransition(settled("A"), { t: "ready", id: "A" })).toEqual(settled("A"));
    expect(reduceTransition(fading("A", "B"), { t: "ready", id: "B" })).toEqual(fading("A", "B"));
  });

  it("fadeEnd settles only for the fading picture", () => {
    expect(reduceTransition(fading("A", "B"), { t: "fadeEnd", id: "B" })).toEqual(settled("B"));
    expect(reduceTransition(fading("A", "B"), { t: "fadeEnd", id: "A" })).toEqual(fading("A", "B"));
    expect(reduceTransition(waiting("A", "B"), { t: "fadeEnd", id: "B" })).toEqual(waiting("A", "B"));
  });
});

describe("useWallpaperTransition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("caps readiness: waiting without a ready report starts the fade at 1500 ms", () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useWallpaperTransition(id),
      { initialProps: { id: "A" } },
    );
    expect(result.current.state).toEqual(settled("A"));

    rerender({ id: "B" });
    expect(result.current.state).toEqual(waiting("A", "B"));

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.state).toEqual(fading("A", "B"));

    act(() => {
      vi.advanceTimersByTime(FADE_MS + 100);
    });
    expect(result.current.state).toEqual(settled("B"));
  });

  it("leaves no timer behind when unmounted while waiting", () => {
    const { rerender, unmount } = renderHook(
      ({ id }: { id: string | null }) => useWallpaperTransition(id),
      { initialProps: { id: "A" } },
    );
    rerender({ id: "B" });

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind when unmounted while fading", () => {
    const { result, rerender, unmount } = renderHook(
      ({ id }: { id: string | null }) => useWallpaperTransition(id),
      { initialProps: { id: "A" } },
    );
    rerender({ id: "B" });
    act(() => result.current.onReady("B"));
    expect(result.current.state).toEqual(fading("A", "B"));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("reduced motion settles directly on ready", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useWallpaperTransition(id),
      { initialProps: { id: "A" } },
    );
    rerender({ id: "B" });
    expect(result.current.state).toEqual(waiting("A", "B"));

    act(() => result.current.onReady("B"));

    expect(result.current.state).toEqual(settled("B"));
  });
});
