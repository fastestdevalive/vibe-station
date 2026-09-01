import { useServerStore } from "@/hooks/useServerStore";
import { sessionLabel } from "@/lib/sessionLabel";

/**
 * Slim banner rendered in a child (subagent) session pane — shows the parent
 * session name and a navigate-back affordance.
 *
 * Returns null when the parentSessionId is not found in the store (e.g. the
 * parent was deleted, or the store hasn't loaded yet) so callers don't need
 * to guard.
 */
export function SubagentBanner({
  parentSessionId,
  onNavigate,
}: {
  parentSessionId: string;
  onNavigate?: (sessionId: string) => void;
}) {
  const parentSession = useServerStore((s) => s.sessions.find((x) => x.id === parentSessionId));

  if (!parentSession) return null;

  const parentName = sessionLabel(parentSession);

  return (
    <div className="chat-subagent-banner" role="status" aria-label={`Subagent of: ${parentName}`}>
      <span className="chat-subagent-banner__label">Subagent</span>
      <span className="chat-subagent-banner__sep" aria-hidden>
        ·
      </span>
      <button
        type="button"
        className="chat-subagent-banner__parent-link"
        onClick={() => onNavigate?.(parentSessionId)}
        title={`Navigate to parent: ${parentName}`}
      >
        ↑ {parentName}
      </button>
    </div>
  );
}
