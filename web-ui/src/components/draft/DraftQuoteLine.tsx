import { useEffect, useRef, useState } from "react";
import { pickDraftQuote } from "@/components/background/draftQuotes";

/** Below this much room the decorative line would crowd the composer. */
const MIN_ROOM_PX = 40;
/** The quote sits this far above the body's bottom edge (design Quote.dc.html). */
const QUOTE_BOTTOM_PX = 18;

/**
 * The draft composer's one decorative quote (mobile parity: same bundled 71
 * quotes, same `quote:<key>` hash, so a draft reads the same on every device).
 * Purely decorative, hence `aria-hidden`. It is drawn at the bottom of
 * `.draft-composer__body` (18px above the edge, over the wallpaper's bottom
 * fade); the wrapper always renders, but its text is dropped when less than
 * 40px separates the composer + hint row from that slot, so the line can never
 * overlap them or squeeze the composer.
 */
export function DraftQuoteLine({ draftId }: { draftId: string }) {
  const quote = pickDraftQuote(draftId);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const targetsRef = useRef<{ body: HTMLElement; stageInner: HTMLElement } | null>(null);
  const [crowded, setCrowded] = useState(false);

  // Runs on every render but only (re)attaches when the measured nodes appear or
  // change: the wrapper is our own child of `.draft-composer__body`, so this is
  // never a stale one-shot `[rootRef]` attach.
  useEffect(() => {
    const body = wrapperRef.current?.parentElement ?? null;
    const stageInner = body?.querySelector<HTMLElement>(".draft-composer__stage-inner") ?? null;
    if (body === null || stageInner === null) return;
    if (targetsRef.current?.body === body && targetsRef.current.stageInner === stageInner) return;
    observerRef.current?.disconnect();
    targetsRef.current = { body, stageInner };
    const measure = () => {
      // `.draft-composer__stage-inner` is a stretched flex item on phones (the
      // phone block zeroes its vertical auto margins), so its own `offsetHeight`
      // is the body's full height: measure its CONTENT bottom (the last visible
      // child, already in body coordinates) instead of the stretched box.
      let contentBottom = stageInner.offsetTop;
      for (const el of Array.from(stageInner.children) as HTMLElement[]) {
        if (el.offsetHeight > 0) contentBottom = Math.max(contentBottom, el.offsetTop + el.offsetHeight);
      }
      const room = body.clientHeight - contentBottom - QUOTE_BOTTOM_PX;
      setCrowded(room < MIN_ROOM_PX);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    observer.observe(stageInner);
    // The stretched stage box never resizes with its content on phones, so the
    // children are observed too (still the one observer).
    for (const el of Array.from(stageInner.children)) observer.observe(el);
    observerRef.current = observer;
  });

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    [],
  );

  if (quote === null) return null;
  return (
    <div className="draft-quote-line" aria-hidden="true" ref={wrapperRef}>
      {crowded ? null : quote.text}
    </div>
  );
}
