import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ghostClipped } from "./folderChooserModel";

interface PathGhostProps {
  /** The real input the ghost mirrors (read for its `scrollLeft`). */
  getInput: () => HTMLInputElement | null;
  /** The input's current value, drawn invisibly so the remainder starts where the typed text ends. */
  typed: string;
  /** The completion suffix, drawn muted right after the typed text. */
  remainder: string;
  /** Called when the remainder's visibility changes: true while it is not fully inside the field. */
  onClippedChange?: (clipped: boolean) => void;
}

/**
 * Inline-completion ghost: a hidden mirror of the typed text plus the visible
 * remainder, in the input's own font (`.path-ghost-field > input { font: inherit }`),
 * shifted by the input's horizontal scroll so it stays glued to the caret.
 */
export function PathGhost({ getInput, typed, remainder, onClippedChange }: PathGhostProps) {
  const [scrollLeft, setScrollLeft] = useState(0);
  const [clipped, setClipped] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const onClippedRef = useRef(onClippedChange);
  onClippedRef.current = onClippedChange;

  // Measure after every change of the text or the input's scroll: the ghost is
  // visible only when the whole remainder fits inside the clipping box.
  useLayoutEffect(() => {
    const next = ghostClipped(
      trackRef.current?.scrollWidth ?? 0,
      scrollLeft,
      boxRef.current?.clientWidth ?? 0,
    );
    setClipped(next);
    onClippedRef.current?.(next);
  }, [typed, remainder, scrollLeft]);

  // No ghost left to report on: the owner's flag must not outlive it.
  useEffect(() => () => onClippedRef.current?.(false), []);

  useLayoutEffect(() => {
    setScrollLeft(getInput()?.scrollLeft ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, remainder]);

  useEffect(() => {
    const input = getInput();
    if (!input) return undefined;
    const sync = () => setScrollLeft(input.scrollLeft);
    input.addEventListener("scroll", sync);
    return () => input.removeEventListener("scroll", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span className="path-ghost" aria-hidden="true" ref={boxRef}>
      <span
        className="path-ghost__track"
        ref={trackRef}
        style={{ transform: `translateX(${-scrollLeft}px)`, visibility: clipped ? "hidden" : undefined }}
      >
        <span className="path-ghost__typed">{typed}</span>
        {remainder}
      </span>
    </span>
  );
}
