import { useEffect, useRef, useState } from "react";

/** A scrub resting on the rail's top row this long loads the earlier turns. */
export const SCRUB_TOP_LOAD_DWELL_MS = 250;
/** Auto-loads one rest may chain; past this a new wheel or move must re-arm. */
export const SCRUB_TOP_LOADS_PER_REST = 3;

export interface UseTopLoadDwellOpts {
  /** The scrub (wheel or drag) rests on the top row or in the cap above it. */
  onTop: boolean;
  /** Earlier turns exist that are not loaded yet. */
  hasMore: boolean;
  /** A load of earlier turns is in flight. */
  loading: boolean;
  /** The gesture that owns the scrub; a change restarts the dwell. */
  gesture: string | null;
  /** Bumped by every wheel row or drag move: user input that starts a new rest. */
  inputSeq: number;
  /** Key of the first loaded turn: it changes when a prepend commits. */
  firstKey: string | undefined;
  /** Starts the load; a returned promise marks it in flight until it settles. */
  onLoad?: () => void | Promise<unknown>;
}

/**
 * Top-of-rail auto-load: once a scrub has rested on the top row for
 * SCRUB_TOP_LOAD_DWELL_MS while earlier turns exist, `onLoad` runs once and
 * the hook latches. Only a committed prepend (the first turn changed), the end
 * of history, or leaving the top row or new input once the load has settled
 * re-arm it, so a load that fails or adds nothing never retries on its own.
 * One rest chains at most SCRUB_TOP_LOADS_PER_REST loads (a filter that hides
 * every prepended turn, or a finger held in the cap); new input starts a new
 * rest. Leaving the top row, a gesture change and unmount cancel a pending dwell.
 */
export function useTopLoadDwell({
  onTop,
  hasMore,
  loading,
  gesture,
  inputSeq,
  firstKey,
  onLoad,
}: UseTopLoadDwellOpts): void {
  const onLoadRef = useRef(onLoad);
  useEffect(() => {
    onLoadRef.current = onLoad;
  });

  const [latched, setLatched] = useState(false);
  const [restLoads, setRestLoads] = useState(0);
  /** The last load's promise has not settled: input must not re-arm a second one. */
  const inFlightRef = useRef(false);

  useEffect(() => {
    setLatched(false);
  }, [firstKey, hasMore]);
  useEffect(() => {
    if (!inFlightRef.current) setLatched(false);
    setRestLoads(0);
  }, [inputSeq]);
  useEffect(() => {
    if (onTop) return;
    if (!inFlightRef.current) setLatched(false);
    setRestLoads(0);
  }, [onTop]);

  const armed =
    onTop && hasMore && !loading && !latched && restLoads < SCRUB_TOP_LOADS_PER_REST && onLoad != null;
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => {
      setLatched(true);
      setRestLoads((n) => n + 1);
      inFlightRef.current = true;
      const settle = () => {
        inFlightRef.current = false;
      };
      Promise.resolve(onLoadRef.current?.()).then(settle, settle);
    }, SCRUB_TOP_LOAD_DWELL_MS);
    return () => clearTimeout(timer);
  }, [armed, gesture]);
}
