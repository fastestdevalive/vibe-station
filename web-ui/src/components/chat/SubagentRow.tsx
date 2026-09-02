import { useMemo } from "react";
import type { Session, SessionState } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT, type TileKind } from "@/hooks/useStore";
import { StatusDot } from "@/components/layout/StatusDot";
import { sessionLabel } from "@/lib/sessionLabel";
import type { WorktreeRolledUpStatus } from "@/lib/worktreeStatus";

const MAX_ROWS = 5;

/** Mirrors `sessionStateToStatus` in LeftSidebar.tsx — StatusDot's prop shape. */
function sessionStateToStatus(state: SessionState): WorktreeRolledUpStatus {
  if (state === "not_started") return "spawning";
  return state;
}

/**
 * Every id a live child might still carry as its `parentSessionId` — the
 * parent's own id plus every archived predecessor found by walking
 * `supersededBy` BACKWARDS (Decision 7). Without this, a parent reset mints
 * a new id and the child-row list goes empty even though the children never
 * moved.
 */
/**
 * Wording for a SUBAGENT's state. `waiting_for_human` is the daemon's name for
 * "blocked, needs a reply" — but a session spawned by an agent is blocked on
 * that agent, not on the person reading this row. Saying "waiting for human"
 * there actively misleads: it tells the user to go answer something that is
 * really their own agent's job to answer. Only the wording changes; the
 * underlying state and every status colour/glyph stay exactly as they are, so
 * this needs no `docs/STATUS-INDICATORS.md` update (AGENTS.md two-file rule).
 */
function statusPhrase(state: SessionState): string {
  if (state === "waiting_for_human") return "waiting for agent";
  return state.replace(/_/g, " ");
}

export function ancestorIds(session: Session, all: Session[]): Set<string> {
  const ids = new Set<string>([session.id]);
  let cur = session;
  for (let i = 0; i < all.length; i++) {
    const pred = all.find((s) => s.supersededBy === cur.id && !ids.has(s.id));
    if (!pred) break;
    ids.add(pred.id);
    cur = pred;
  }
  return ids;
}

/**
 * Resolve a (possibly reset) session id FORWARD through `supersededBy` to its
 * live successor — the mirror of `ancestorIds`'s backward walk, used to find
 * a child's parent after the parent itself was reset (Decision 12).
 */
function resolveForward(id: string, byId: Map<string, Session>): Session | null {
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur?.supersededBy && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = byId.get(cur.supersededBy);
    if (!next) break;
    cur = next;
  }
  return cur ?? null;
}

export interface SubagentRowProps {
  /** The session this row-group is anchored on (the "self" side of the relationship). */
  session: Session;
  onOpen: (target: Session) => void;
}

/**
 * Renders BOTH directions of the parent/child relationship for one session
 * (Decision 12): the parent's list of live children (subagent-ux-v2 CUJ 1),
 * and — when `session` itself has a parent — a single "↑ Parent" link above
 * them. Nothing renders when there is nothing to show.
 */
export function SubagentRow({ session, onOpen }: SubagentRowProps) {
  const allSessions = useServerStore((s) => s.sessions);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);

  const byId = useMemo(() => new Map(allSessions.map((s) => [s.id, s])), [allSessions]);

  const parent = useMemo(() => {
    if (!session.parentSessionId) return null;
    return resolveForward(session.parentSessionId, byId);
  }, [session.parentSessionId, byId]);

  const children = useMemo(() => {
    const ancestors = ancestorIds(session, allSessions);
    return allSessions.filter(
      (s) =>
        s.id !== session.id &&
        s.parentSessionId &&
        ancestors.has(s.parentSessionId) &&
        // A reset predecessor is replaced by its successor (Decision 7) —
        // the successor carries the SAME parentSessionId forward (1.4) and
        // shows on its own merits, so a superseded row would be a duplicate.
        !s.supersededBy,
    );
  }, [session, allSessions]);

  if (!parent && children.length === 0) return null;

  const visibleChildren = children.slice(0, MAX_ROWS);
  const overflow = children.length - visibleChildren.length;

  const statusFor = (s: Session): SessionState => sessionStates[s.id] ?? s.state;

  return (
    <div className="chat-subagent-row">
      {parent ? (
        <button
          type="button"
          className="chat-subagent-row__item chat-subagent-row__item--parent"
          onClick={() => parent.worktreeId === session.worktreeId && onOpen(parent)}
          disabled={parent.worktreeId !== session.worktreeId}
          title={parent.worktreeId === session.worktreeId ? undefined : "This parent is in a different worktree"}
        >
          <span className="chat-subagent-row__arrow" aria-hidden="true">
            ↑
          </span>
          <span className="chat-subagent-row__label">Parent · {sessionLabel(parent)}</span>
        </button>
      ) : null}
      {visibleChildren.length > 0 ? (
        <span className="chat-subagent-row__caption">Subagents:</span>
      ) : null}
      {visibleChildren.map((child) => {
        const sameWorktree = child.worktreeId === session.worktreeId;
        return (
          <button
            key={child.id}
            type="button"
            className={`chat-subagent-row__item${child.archivedAt ? " chat-subagent-row__item--archived" : ""}`}
            onClick={() => sameWorktree && onOpen(child)}
            disabled={!sameWorktree}
            title={
              sameWorktree
                ? `${sessionLabel(child)} — ${statusPhrase(statusFor(child))}`
                : "This subagent is in a different worktree"
            }
          >
            <StatusDot status={sessionStateToStatus(statusFor(child))} pr={null} />
            <span className="chat-subagent-row__label">{sessionLabel(child)}</span>
          </button>
        );
      })}
      {overflow > 0 ? <span className="chat-subagent-row__more">+{overflow} more</span> : null}
    </div>
  );
}

/**
 * Tap behavior (Decision 6): a tile in workspace-canvas mode, else a tab
 * switch — never a cross-worktree navigation (Requirement 7). Exported
 * separately from the component so `ChatPane` can supply the actual store
 * actions without this file importing the whole `useWorkspaceStore` surface
 * for every consumer of the presentational piece above.
 */
export function openSubagentSession(
  target: Session,
  from: Session,
  store: {
    layoutByWorktree: ReturnType<typeof useWorkspaceStore.getState>["layoutByWorktree"];
    workspaceDocs: ReturnType<typeof useWorkspaceStore.getState>["workspaceDocs"];
    insertTileIntoWorkspaceDoc: ReturnType<typeof useWorkspaceStore.getState>["insertTileIntoWorkspaceDoc"];
    insertTileIntoScratchCanvas: ReturnType<typeof useWorkspaceStore.getState>["insertTileIntoScratchCanvas"];
    setActiveSession: ReturnType<typeof useWorkspaceStore.getState>["setActiveSession"];
    setActiveTerminalSession: ReturnType<typeof useWorkspaceStore.getState>["setActiveTerminalSession"];
  },
): void {
  if (target.worktreeId !== from.worktreeId) return; // Requirement 7 — never cross-worktree
  const worktreeId = from.worktreeId;
  const layout = worktreeId ? (store.layoutByWorktree[worktreeId] ?? DEFAULT_WORKTREE_LAYOUT) : DEFAULT_WORKTREE_LAYOUT;
  // The active-slot switch runs in BOTH layout modes. In workspace mode the
  // tile insert is idempotent (useStore returns the state unchanged when a
  // tile for this session already exists) — and `useServerSync` already
  // auto-inserts a tile for every spawned child — so without this the common
  // case (parent already tiled) would make the tap a silent no-op.
  const activate: TileKind = target.type === "terminal" ? "terminal" : "agent";
  if (activate === "terminal") store.setActiveTerminalSession(target.id);
  else store.setActiveSession(target.id);
  if (worktreeId && layout.layoutMode === "workspace") {
    if (layout.activeWorkspaceId && store.workspaceDocs[layout.activeWorkspaceId]) {
      store.insertTileIntoWorkspaceDoc(layout.activeWorkspaceId, activate, target.id, target.worktreeId ?? undefined);
    } else {
      store.insertTileIntoScratchCanvas(worktreeId, activate, target.id, target.worktreeId ?? undefined);
    }
  }
}
