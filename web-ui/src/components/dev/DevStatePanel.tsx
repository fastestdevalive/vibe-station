import { useEffect, useRef, useState, type ReactNode } from "react";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import type { PrStatus, SessionState } from "@/api/types";

/**
 * Dev-only floating popup for faking `session:state` transitions on real
 * sessions, without touching the daemon at all. Patches the client-side
 * stores directly (same two calls the real WS handler makes in
 * useServerSync.ts) — purely for visually testing the Workspaces feature's
 * colored-border interaction states.
 *
 * Toggle with Ctrl+Shift+D (Cmd+Shift+D on Mac). Not a real feature — a real
 * `session:state` WS event, or a page reload, resets any fake state applied
 * here, since server truth always wins.
 */
const STATES: SessionState[] = [
  "not_started",
  "working",
  "idle",
  "waiting_for_human",
  "done",
  "exited",
];

/**
 * PR-axis values, orthogonal to `SessionState` — the two combine via
 * `resolveStatusClass` (see `lib/statusColor.ts`), so both dropdowns matter:
 * e.g. `waiting_for_human` + `open` renders BLUE, not red.
 * `"(unset)"` clears the field entirely (no PR ever checked).
 */
const PR_STATES = ["(unset)", "none", "draft", "open", "merged", "closed"] as const;
type PrChoice = (typeof PR_STATES)[number];

export function DevStatePanel(): ReactNode {
  const devEnabled =
    import.meta.env.DEV || localStorage.getItem("vs:devpanel") === "1";

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 24, y: 24 });
  const [sessionId, setSessionId] = useState<string>("");
  const [state, setState] = useState<SessionState>("working");
  const [prState, setPrState] = useState<PrChoice>("(unset)");

  const sessions = useServerStore((s) => s.sessions);
  const worktrees = useServerStore((s) => s.worktrees);

  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );

  useEffect(() => {
    if (!devEnabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [devEnabled]);

  useEffect(() => {
    if (!devEnabled) return;
    function onMove(e: MouseEvent) {
      const d = drag.current;
      if (!d) return;
      setPos({ x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) });
    }
    function onUp() {
      drag.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [devEnabled]);

  if (!devEnabled || !open) return null;

  function handleApply() {
    if (!sessionId) return;
    const patch: { state: SessionState; lifecycleState: SessionState; pr?: PrStatus } = {
      state,
      lifecycleState: state,
    };
    if (prState !== "(unset)") {
      // `prBranch` MUST match the session's worktree's current branch or
      // `worktreePrStatus` filters the PR out by design (D20) — so mirror the
      // real branch here, otherwise the colour silently won't render.
      const session = sessions.find((s) => s.id === sessionId);
      const branch = worktrees.find((w) => w.id === session?.worktreeId)?.branch;
      patch.pr =
        prState === "none"
          ? { state: "none", checkedAt: new Date().toISOString(), prBranch: branch }
          : {
              state: prState,
              number: 999,
              url: "https://github.com/example/repo/pull/999",
              checkedAt: new Date().toISOString(),
              prBranch: branch,
            };
    }
    useServerStore.getState().applySessionUpdated(sessionId, patch);
    useWorkspaceStore.getState().patchSessionState(sessionId, state);
  }

  return (
    <div
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        zIndex: 2000,
        width: 280,
        background: "#1e1e1e",
        color: "#e0e0e0",
        border: "1px solid #444",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        fontSize: 12,
        fontFamily: "system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <div
        onMouseDown={(e) => {
          drag.current = {
            startX: e.clientX,
            startY: e.clientY,
            origX: pos.x,
            origY: pos.y,
          };
        }}
        style={{
          cursor: "move",
          padding: "6px 10px",
          background: "#2a2a2a",
          borderBottom: "1px solid #444",
          fontWeight: 600,
          userSelect: "none",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>DEV: State Simulator</span>
        {/* Two orthogonal axes — lifecycle + PR. Precedence (D18):
            working → pr=merged → pr=open → waiting_for_human → idle. */}
        <button
          onClick={() => setOpen(false)}
          style={{
            background: "transparent",
            border: "none",
            color: "#aaa",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Session
          <select
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            style={{
              background: "#111",
              color: "#e0e0e0",
              border: "1px solid #444",
              borderRadius: 4,
              padding: "4px 6px",
            }}
          >
            <option value="">— select session —</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? s.id}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          State
          <select
            value={state}
            onChange={(e) => setState(e.target.value as SessionState)}
            style={{
              background: "#111",
              color: "#e0e0e0",
              border: "1px solid #444",
              borderRadius: 4,
              padding: "4px 6px",
            }}
          >
            {STATES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          PR state (orthogonal axis)
          <select
            value={prState}
            onChange={(e) => setPrState(e.target.value as PrChoice)}
            style={{
              background: "#111",
              color: "#e0e0e0",
              border: "1px solid #444",
              borderRadius: 4,
              padding: "4px 6px",
            }}
          >
            {PR_STATES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={handleApply}
          disabled={!sessionId}
          style={{
            background: sessionId ? "#3b6fe0" : "#444",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            padding: "6px 8px",
            cursor: sessionId ? "pointer" : "not-allowed",
            fontWeight: 600,
          }}
        >
          Apply
        </button>

        <p style={{ margin: 0, color: "#888", fontSize: 10, lineHeight: 1.4 }}>
          Local-only fake — a real `session:state` event or a page reload
          resets this (server truth wins).
        </p>
      </div>
    </div>
  );
}
