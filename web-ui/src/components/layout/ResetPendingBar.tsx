import { useResetProgress } from "@/hooks/useResetProgress";
import type { ApiInstance } from "@/api";

interface ResetPendingBarProps {
  api: Pick<ApiInstance, "cancelReset">;
  sessionId: string | null | undefined;
}

/**
 * In-pane in-progress cue for a held-open reset/switch request (Decision 9).
 *
 * Replaces the blurred full-pane overlay + dismissed chip: the pane stays
 * usable (chat composer disabled separately), and this bar says what is
 * happening and offers Cancel → `POST /sessions/:id/reset/cancel`. Rendered in
 * `ChatPane` where the chip was, and in the terminal header overlay — never by
 * restructuring `TerminalPane` (AGENTS.md § Terminal).
 */
export function ResetPendingBar({ api, sessionId }: ResetPendingBarProps) {
  const kind = useResetProgress((s) => (sessionId ? s.active[sessionId] : undefined));
  if (!sessionId || !kind) return null;
  const label = kind === "summary" ? "Writing the summary… up to 2 min" : "Waiting for the current turn…";
  return (
    <div className="reset-pending-bar" role="status" aria-live="polite">
      <span className="chat-spinner" aria-hidden />
      <span className="reset-pending-bar__label">{label}</span>
      <button
        type="button"
        className="reset-pending-bar__cancel"
        onClick={() => void api.cancelReset(sessionId).catch(() => {})}
      >
        Cancel
      </button>
    </div>
  );
}
