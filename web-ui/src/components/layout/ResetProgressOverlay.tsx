import { useEffect, useRef } from "react";
import { useResetProgress } from "@/hooks/useResetProgress";

/**
 * Covers just this agent's pane while its "Reset with handoff" is running.
 * Close hides the overlay (e.g. the agent isn't responding) — the reset itself
 * keeps going in the background and ends on its own (bounded by the daemon's
 * handoff timeout), so closing is always safe.
 *
 * While shown, the rest of the pane is made `inert` (mouse AND keyboard — the
 * overlay alone only blocks the mouse, so the user could keep typing into the
 * agent mid-handoff) via direct DOM attributes on the overlay's siblings, so
 * the pane's React tree (TerminalPane/ChatPane) is never restructured.
 */
export function ResetProgressOverlay({ sessionId }: { sessionId: string | null | undefined }) {
  const status = useResetProgress((s) => (sessionId ? s.active[sessionId] : undefined));
  const dismiss = useResetProgress((s) => s.dismiss);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const shown = !!sessionId && status === "shown";

  useEffect(() => {
    const root = rootRef.current;
    if (!shown || !root?.parentElement) return undefined;
    const inerted = Array.from(root.parentElement.children).filter(
      (el): el is HTMLElement => el !== root && el instanceof HTMLElement && !el.hasAttribute("inert"),
    );
    inerted.forEach((el) => el.setAttribute("inert", ""));
    closeRef.current?.focus();
    return () => inerted.forEach((el) => el.removeAttribute("inert"));
  }, [shown]);

  if (!shown || !sessionId) return null;
  return (
    <div className="reset-progress-overlay" ref={rootRef}>
      <div className="reset-progress-overlay__card">
        <div className="reset-progress-overlay__title" role="status" aria-live="polite">
          <span className="chat-spinner" aria-hidden /> Resetting with handoff…
        </div>
        <p className="reset-progress-overlay__text">
          Waiting for the agent to write its handoff summary, then a fresh session takes its place. This can take a
          minute. If the agent isn't responding, close this — the reset finishes on its own (it gives up waiting
          after about two minutes and resets without a summary).
        </p>
        <button type="button" ref={closeRef} onClick={() => dismiss(sessionId)}>
          Close
        </button>
      </div>
    </div>
  );
}
