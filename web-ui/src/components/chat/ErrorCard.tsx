interface ErrorCardProps {
  text: string;
  /** Retry affordance (re-send the last user message). Omit to hide. */
  onRetry?: () => void;
}

/** Turn-level error card with an optional Retry button (CUJ 3). */
export function ErrorCard({ text, onRetry }: ErrorCardProps) {
  return (
    <div className="chat-error-card" role="alert">
      <div className="chat-error-card__body">
        <span className="chat-error-card__icon" aria-hidden>⚠</span>
        <span className="chat-error-card__text">{text || "The turn failed."}</span>
      </div>
      {onRetry ? (
        <button type="button" className="chat-error-card__retry" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
