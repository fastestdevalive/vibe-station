import { useCallback, useEffect, useMemo, useRef } from "react";

/** Wheel mode jumps the chat to the highlighted row once the wheel has rested this long. */
export const WHEEL_JUMP_IDLE_MS = 700;
/** Leaving the region commits a pending wheel jump only once the wheel session is this old; sooner cancels it. */
export const WHEEL_ARM_MS = 400;

export interface WheelAutoJump {
  /**
   * A wheel scrub rested on `anchor`: (re)start the idle wait. `newSession` marks
   * the first wheel of a session (the list was not in wheel mode). Returns false,
   * scheduling nothing, while the pointer is outside the region (a frame or a
   * momentum event landing after the leave).
   */
  schedule(anchor: string, newSession: boolean): boolean;
  /** The pointer entered the region (rail or list). */
  enter(): void;
  /** The pointer left the region: commit a pending jump when armed, else drop it. */
  leave(): void;
  /** Drop a pending jump. */
  cancel(): void;
  /** An explicit jump (Enter, a row or beat click): always jumps and supersedes a pending one. */
  jumpNow(anchor: string): void;
  /** The list left wheel mode or closed: drop everything. */
  reset(): void;
}

/**
 * Wheel mode's auto-jump: the highlighted row is jumped to after WHEEL_JUMP_IDLE_MS
 * without a wheel; the caller settles (hides) the list with that jump.
 *
 * `isActive` reads whether the list is in wheel mode right now: a timer that
 * outlives the mode never jumps.
 */
export function useWheelAutoJump(onJump: (anchor: string) => void, isActive: () => boolean): WheelAutoJump {
  const latest = useRef({ onJump, isActive });
  useEffect(() => {
    latest.current = { onJump, isActive };
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string | null>(null);
  /** When the current wheel session's first wheel landed (Date.now). */
  const startedAtRef = useRef(0);
  /** The pointer left the region (not a rail <-> list crossing) and has not come back. */
  const outsideRef = useRef(false);
  /** A leave ended the session: the next wheel starts a new one. */
  const restartRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
  }, []);

  const commit = useCallback(() => {
    const anchor = pendingRef.current;
    cancel();
    if (anchor == null || !latest.current.isActive()) return;
    latest.current.onJump(anchor);
  }, [cancel]);

  const schedule = useCallback(
    (anchor: string, newSession: boolean) => {
      if (outsideRef.current) return false;
      if (newSession || restartRef.current) {
        startedAtRef.current = Date.now();
        restartRef.current = false;
      }
      pendingRef.current = anchor;
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(commit, WHEEL_JUMP_IDLE_MS);
      return true;
    },
    [commit],
  );

  const enter = useCallback(() => {
    outsideRef.current = false;
  }, []);

  const leave = useCallback(() => {
    outsideRef.current = true;
    restartRef.current = true;
    if (Date.now() - startedAtRef.current >= WHEEL_ARM_MS) commit();
    else cancel();
  }, [commit, cancel]);

  const jumpNow = useCallback(
    (anchor: string) => {
      cancel();
      latest.current.onJump(anchor);
    },
    [cancel],
  );

  const reset = useCallback(() => {
    cancel();
    outsideRef.current = false;
    restartRef.current = false;
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  return useMemo(
    () => ({ schedule, enter, leave, cancel, jumpNow, reset }),
    [schedule, enter, leave, cancel, jumpNow, reset],
  );
}
