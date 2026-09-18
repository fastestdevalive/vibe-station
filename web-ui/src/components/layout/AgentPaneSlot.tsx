import { Minus, Plus } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { PrStatus, Session } from "@/api/types";
import { TerminalPane } from "./TerminalPane";
import { TerminalChannelToggle } from "./TerminalChannelToggle";
import { TerminalAttachmentUpload } from "./TerminalAttachmentUpload";
import { ChatPane } from "./ChatPane";
import { SubagentRow, openSubagentSession } from "@/components/chat/SubagentRow";
import { sessionStatus } from "@/lib/worktreeStatus";
import { resolveStatusClass } from "@/lib/statusColor";
import { useWorkspaceStore } from "@/hooks/useStore";

interface AgentPaneSlotProps {
  api: ApiInstance;
  /** Active agent session for this slot (worktree main/additional or direct). */
  sessionId: string | null;
  session?: Session;
  /**
   * The session's worktree's CURRENT branch (D20), or `null`/`undefined` for
   * a direct (worktree-less) session. Required to branch-guard `pr` the same
   * way `WorkspaceCanvas.tsx`/`LeftSidebar.tsx` do — without it, a stale PR
   * from a branch the worktree has since switched off of would still colour
   * the pane border.
   */
  branch?: string | null;
  /**
   * The worktree's PR (BLOCKING-2 fix), already resolved by the caller via
   * `worktreePrStatus()` — the daemon writes `session.pr` only to a
   * worktree's `isMain` session, so a sibling agent's pane must NOT read
   * `session.pr` directly (it's always empty there). `worktreePrStatus()`
   * already branch-guards internally (D20), so this is `null` whenever the
   * PR was last checked against a branch the worktree has since left.
   */
  pr?: PrStatus | null;
  /**
   * True when this slot renders as a floating tile on the workspace canvas
   * (workspace/workspace-view layoutMode) rather than the classic docked pane.
   * In canvas mode the panes must NEVER steal keyboard focus on mount — the
   * user navigates tiles by clicking, and yanking the caret/IME onto a tile is
   * unwanted (navigation-focus-change). Classic mode focuses on a non-touch
   * device.
   */
  canvasMode?: boolean;
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
export function AgentPaneSlot({ api, sessionId, session, branch = null, pr = null, canvasMode = false }: AgentPaneSlotProps) {
  const isJson = session?.channel === "json";
  const bumpTerminalFont = useWorkspaceStore((s) => s.bumpTerminalFont);
  const layoutByWorktree = useWorkspaceStore((s) => s.layoutByWorktree);
  const workspaceDocs = useWorkspaceStore((s) => s.workspaceDocs);
  const insertTileIntoWorkspaceDoc = useWorkspaceStore((s) => s.insertTileIntoWorkspaceDoc);
  const insertTileIntoScratchCanvas = useWorkspaceStore((s) => s.insertTileIntoScratchCanvas);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const setActiveTerminalSession = useWorkspaceStore((s) => s.setActiveTerminalSession);

  // `session.state` (not `.lifecycleState`) — the live `session:state` WS
  // handler (useServerSync.ts) only patches `.state` on the session object;
  // `.lifecycleState` is only ever set from the initial REST fetch (or by the
  // dev-only state-simulation panel, which patches both, masking this in
  // manual testing). Reading `.lifecycleState` here left both the border
  // color below and this terminal-live check permanently stuck on whatever
  // value the session had on page load. WorkspaceCanvas.tsx already reads
  // `.state` for the same reason — match it.
  const isTerminal = !isJson && !!session;
  const terminalLive = isTerminal && session!.state !== "exited" && session!.state !== "done";
  // The font-size buttons and terminal→Rich Chat toggle for exited sessions.
  // When the session exits, these are handed to `TerminalPane`, which renders
  // them in-flow BELOW its "Session exited / Resume" banner.
  const exitedControls = isTerminal && !terminalLive ? (
    <div className="terminal-font-overlay">
      <button type="button" className="terminal-font-overlay__btn" aria-label="Decrease agent font" onClick={() => bumpTerminalFont(-0.05)}>
        <Minus size={11} />
      </button>
      <button type="button" className="terminal-font-overlay__btn" aria-label="Increase agent font" onClick={() => bumpTerminalFont(0.05)}>
        <Plus size={11} />
      </button>
      <TerminalChannelToggle api={api} session={session!} />
    </div>
  ) : undefined;

  // Same colored-rectangle treatment as a workspace tile (WorkspaceCanvas.tsx's
  // `.workspace-canvas__tile--<status>`), on the pane's own chrome — this
  // component is shared by the classic single-agent-pane view AND direct
  // sessions (no tile header to host a StatusDot dot in either case), so a
  // border is the only "colored rectangle" surface available here.
  const showAgentStatusBorders = useWorkspaceStore((s) => s.showAgentStatusBorders);
  // D20 — branch-guard the PR the same way WorkspaceCanvas/LeftSidebar do: a
  // PR only colours the border while it was last checked against this
  // session's worktree's CURRENT branch. `branch` is null for a direct
  // (worktree-less) session, which correctly suppresses the PR unconditionally.
  // `pr` is already resolved per-worktree by the caller (BLOCKING-2 fix) —
  // NOT read off `session.pr` directly, since the daemon only ever writes
  // `pr` to a worktree's `isMain` session and this pane may host a sibling.
  const sessionPr = pr && branch && pr.prBranch === branch ? pr : null;
  const status =
    session && showAgentStatusBorders
      ? resolveStatusClass(sessionStatus(session.state), sessionPr)
      : null;
  return (
    <div className={`agent-pane-slot${status ? ` agent-pane-slot--${status}` : ""}`}>
      <div
        className="agent-pane-slot__terminal"
        style={isJson ? { display: "none" } : { flex: 1, minHeight: 0, display: "flex", position: "relative" }}
      >
        <TerminalPane
          api={api}
          sessionId={isJson ? null : sessionId}
          session={isJson ? undefined : session}
          channelToggle={exitedControls}
          focusOnMount={!canvasMode}
        />
        {isTerminal && terminalLive ? (
          <div className="agent-pane-header agent-pane-header--overlay">
            <div className="agent-pane-header__left">
              <TerminalAttachmentUpload api={api} session={session!} />
              <div className="agent-pane-header__subagents">
                <SubagentRow
                  session={session!}
                  api={api}
                  onOpen={(target) =>
                    openSubagentSession(target, session!, {
                      layoutByWorktree,
                      workspaceDocs,
                      insertTileIntoWorkspaceDoc,
                      insertTileIntoScratchCanvas,
                      setActiveSession,
                      setActiveTerminalSession,
                    })
                  }
                />
              </div>
            </div>
            <div className="agent-pane-header__controls">
              <div className="terminal-font-overlay__btns">
                <button
                  type="button"
                  className="terminal-font-overlay__btn"
                  aria-label="Decrease agent font"
                  onClick={() => bumpTerminalFont(-0.05)}
                >
                  <Minus size={11} />
                </button>
                <button
                  type="button"
                  className="terminal-font-overlay__btn"
                  aria-label="Increase agent font"
                  onClick={() => bumpTerminalFont(0.05)}
                >
                  <Plus size={11} />
                </button>
              </div>
              <TerminalChannelToggle api={api} session={session!} />
            </div>
          </div>
        ) : null}
      </div>
      <ChatPane api={api} session={isJson ? session : undefined} visible={!!isJson} focusOnMount={!canvasMode} />
    </div>
  );
}
