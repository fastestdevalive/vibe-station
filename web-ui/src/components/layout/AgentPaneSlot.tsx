import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { TerminalPane } from "./TerminalPane";
import { ChatPane } from "./ChatPane";

interface AgentPaneSlotProps {
  api: ApiInstance;
  /** Active agent session for this slot (worktree main/additional or direct). */
  sessionId: string | null;
  session?: Session;
}

/**
 * Agent view for one pane slot.
 *
 * The `TerminalPane` is **permanently mounted** at a stable React tree position
 * (Decision 14 / web-ui AGENTS.md §7-41). When the active agent is a JSON
 * session it is passed `sessionId={null}` (no TTY stream) and hidden via CSS,
 * while the `ChatPane` — mounted right beside it — becomes visible. Switching a
 * tab between a TTY and a JSON agent therefore only flips props/visibility; it
 * never unmounts the terminal, so it cannot recreate the ghost-stream remount
 * bug fixed in 9dc10ef.
 */
export function AgentPaneSlot({ api, sessionId, session }: AgentPaneSlotProps) {
  const isJson = session?.channel === "json";
  return (
    <div className="agent-pane-slot">
      <div
        className="agent-pane-slot__terminal"
        style={isJson ? { display: "none" } : { flex: 1, minHeight: 0, display: "flex" }}
      >
        <TerminalPane
          api={api}
          sessionId={isJson ? null : sessionId}
          session={isJson ? undefined : session}
        />
      </div>
      <ChatPane api={api} session={isJson ? session : undefined} visible={!!isJson} />
    </div>
  );
}
