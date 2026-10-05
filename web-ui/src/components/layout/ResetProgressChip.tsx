import { useResetProgress } from "@/hooks/useResetProgress";

/**
 * Subtle "still resetting" cue shown once the user has closed the
 * `ResetProgressOverlay`. The reset keeps running in the background (up to the
 * daemon's handoff timeout) with no other signal, so this keeps it visible.
 * Clicking reopens the overlay. Renders nothing unless the overlay is dismissed.
 */
export function ResetProgressChip({ sessionId }: { sessionId: string | null | undefined }) {
  const status = useResetProgress((s) => (sessionId ? s.active[sessionId] : undefined));
  const start = useResetProgress((s) => s.start);
  if (!sessionId || status !== "dismissed") return null;
  return (
    <button
      type="button"
      className="reset-progress-chip"
      role="status"
      aria-live="polite"
      title="Reset with handoff is still running — click for details"
      onClick={() => start(sessionId)}
    >
      <span className="chat-spinner" aria-hidden /> Resetting with handoff…
    </button>
  );
}
