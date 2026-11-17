import { useCallback, useEffect, useState } from "react";

/** Keep in step with the `wp-slide-in` keyframe in `windowBackground.css`. */
export const FADE_MS = 350;
/** A slow first bake must never freeze the old picture. */
const READY_TIMEOUT_MS = 1500;

export interface Slide {
  id: string;
}

/**
 * The window's picture state machine. There is never more than one outgoing and
 * one incoming picture, so a fast series of switches cannot stack slides.
 */
export type TransitionState =
  | { phase: "empty" }
  | { phase: "settled"; current: Slide }
  /** The incoming slide is mounted at opacity 0 while its picture loads. */
  | { phase: "waiting"; current: Slide; incoming: Slide }
  /** The incoming slide is dissolving in on top of the current one. */
  | { phase: "fading"; current: Slide; incoming: Slide };

export type TransitionEvent =
  | { t: "target"; id: string | null }
  | { t: "ready"; id: string }
  | { t: "fadeEnd"; id: string };

const EMPTY: TransitionState = { phase: "empty" };

/**
 * Pure reducer. `reducedMotion` swaps instantly at ready instead of fading.
 * A no-op returns the SAME state object, so React can skip the re-render.
 */
export function reduceTransition(
  state: TransitionState,
  event: TransitionEvent,
  reducedMotion = false,
): TransitionState {
  if (event.t === "target") {
    const id = event.id;
    if (id === null) return state.phase === "empty" ? state : EMPTY;

    switch (state.phase) {
      case "empty":
        return { phase: "settled", current: { id } };
      case "settled":
        // Same image: nothing happens, even if the route or agent changed.
        return state.current.id === id
          ? state
          : { phase: "waiting", current: state.current, incoming: { id } };
      case "waiting":
        if (state.incoming.id === id) return state;
        if (state.current.id === id) return { phase: "settled", current: state.current };
        return { phase: "waiting", current: state.current, incoming: { id } };
      case "fading":
        if (state.incoming.id === id) return state;
        // Promote the fading picture to current at the opacity it already
        // reached; the previous current is dropped.
        return { phase: "waiting", current: state.incoming, incoming: { id } };
    }
  }

  if (event.t === "ready") {
    if (state.phase !== "waiting" || state.incoming.id !== event.id) return state;
    return reducedMotion
      ? { phase: "settled", current: state.incoming }
      : { phase: "fading", current: state.current, incoming: state.incoming };
  }

  // fadeEnd
  if (state.phase !== "fading" || state.incoming.id !== event.id) return state;
  return { phase: "settled", current: state.incoming };
}

function readReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface WallpaperTransition {
  state: TransitionState;
  /** The incoming slide reports its complete picture (image decoded + effect settled). */
  onReady: (id: string) => void;
  /** The incoming slide's fade-in animation finished. */
  onFadeEnd: (id: string) => void;
}

/**
 * Owns the current/incoming picture state for `WindowBackground`. The first
 * paint is `settled` (nothing to fade from), and the readiness cap plus the
 * fade-end fallback keep a slow bake or a hidden tab from stranding the state.
 * Both timers are cleared on every state change and on unmount.
 */
export function useWallpaperTransition(targetId: string | null): WallpaperTransition {
  const [reduced, setReduced] = useState(readReducedMotion);
  const [state, setState] = useState<TransitionState>(() =>
    targetId === null ? EMPTY : { phase: "settled", current: { id: targetId } },
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    setState((s) => reduceTransition(s, { t: "target", id: targetId }, reduced));
  }, [targetId, reduced]);

  useEffect(() => {
    if (state.phase === "waiting") {
      const id = state.incoming.id;
      const timer = setTimeout(
        () => setState((s) => reduceTransition(s, { t: "ready", id }, reduced)),
        READY_TIMEOUT_MS,
      );
      return () => clearTimeout(timer);
    }
    if (state.phase === "fading") {
      const id = state.incoming.id;
      const timer = setTimeout(
        () => setState((s) => reduceTransition(s, { t: "fadeEnd", id }, reduced)),
        FADE_MS + 100,
      );
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state, reduced]);

  const onReady = useCallback(
    (id: string) => setState((s) => reduceTransition(s, { t: "ready", id }, reduced)),
    [reduced],
  );
  const onFadeEnd = useCallback(
    (id: string) => setState((s) => reduceTransition(s, { t: "fadeEnd", id }, reduced)),
    [reduced],
  );

  return { state, onReady, onFadeEnd };
}
