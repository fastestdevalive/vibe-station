import { Maximize2, Minimize2, Minus, Plus } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { useWorkspaceStore, type WorkspacePaneFullscreen } from "@/hooks/useStore";
import { NewTabDialog } from "@/components/dialogs/NewTabDialog";
import { NewTerminalDialog } from "@/components/dialogs/NewTerminalDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";

type TabKind = "agent" | "terminal";

interface TabsStripProps {
  api: ApiInstance;
  worktreeId: string | null;
  /** "agent" → agent pane tabs; "terminal" → bottom dock terminal tabs. */
  kind: TabKind;
}

export function TabsStrip({ api, worktreeId, kind }: TabsStripProps) {
  const isAgent = kind === "agent";
  const fsTarget: WorkspacePaneFullscreen = isAgent ? "agent" : "terminal";

  const activeSessionId = useWorkspaceStore((s) =>
    isAgent ? s.activeSessionId : s.activeTerminalSessionId,
  );
  const setActiveSession = useWorkspaceStore((s) =>
    isAgent ? s.setActiveSession : s.setActiveTerminalSession,
  );
  const bumpTerminalFont = useWorkspaceStore((s) => s.bumpTerminalFont);
  const workspacePaneFullscreen = useWorkspaceStore((s) => s.workspacePaneFullscreen);
  const setWorkspacePaneFullscreen = useWorkspaceStore((s) => s.setWorkspacePaneFullscreen);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<Session | null>(null);

  useEffect(() => {
    if (!worktreeId) {
      setSessions([]);
      return;
    }
    const matches = (s: Session) => s.type === kind;
    void (async () => {
      const all = await api.listSessions(worktreeId);
      const ss = all.filter(matches);
      setSessions(ss);
      const store = useWorkspaceStore.getState();
      store.syncSessionsFromApi(all);
      const cur = isAgent ? store.activeSessionId : store.activeTerminalSessionId;
      if (cur && ss.some((s) => s.id === cur)) {
        return;
      }
      const last = isAgent
        ? store.lastSessionByWorktree[worktreeId]
        : store.lastTerminalByWorktree[worktreeId];
      const main = isAgent ? ss.find((s) => s.slot === "m") : undefined;
      const pick =
        (last && ss.some((s) => s.id === last) ? last : null) ??
        main?.id ??
        ss[0]?.id ??
        null;
      if (pick) setActiveSession(pick);
    })();

    const offCreated = api.on("session:created", (ev) => {
      if (ev.type !== "session:created" || !ev.snapshot) return;
      if (ev.snapshot.worktreeId !== worktreeId) return;
      if (!matches(ev.snapshot)) return;
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === ev.snapshot!.id);
        return exists ? prev : [...prev, ev.snapshot!];
      });
      // Seed lifecycle state from the snapshot so the spawning placeholder
      // shows "Starting…" while state is "not_started", instead of skipping
      // straight to "Reconnecting…" when session:state working arrives later.
      useWorkspaceStore.getState().patchSessionState(ev.snapshot.id, ev.snapshot.state);
      setActiveSession(ev.snapshot.id);
    });

    const offDeleted = api.on("session:deleted", (ev) => {
      if (ev.type !== "session:deleted") return;
      setSessions((prev) => {
        if (!prev.some((s) => s.id === ev.sessionId)) return prev;
        const idx = prev.findIndex((s) => s.id === ev.sessionId);
        const remaining = prev.filter((s) => s.id !== ev.sessionId);
        // If the closed tab was the active one, switch focus to a sibling so
        // the user doesn't stare at an [exited] view of a session that no
        // longer exists. Prefer the tab immediately before the closed one;
        // fall back to the first remaining tab.
        const st = useWorkspaceStore.getState();
        const cur = isAgent ? st.activeSessionId : st.activeTerminalSessionId;
        if (cur === ev.sessionId && remaining.length > 0) {
          const beforeId = idx > 0 ? prev[idx - 1]?.id : null;
          const target = beforeId && remaining.some((r) => r.id === beforeId)
            ? beforeId
            : remaining[0]!.id;
          setActiveSession(target);
        }
        return remaining;
      });
    });

    return () => {
      offCreated();
      offDeleted();
    };
  }, [api, worktreeId, kind, isAgent, setActiveSession]);

  async function refreshTabs() {
    if (!worktreeId) return;
    const all = await api.listSessions(worktreeId);
    setSessions(all.filter((s) => s.type === kind));
    useWorkspaceStore.getState().syncSessionsFromApi(all);
  }

  const fsActive = workspacePaneFullscreen === fsTarget;
  const ariaLabel = isAgent ? "Agent sessions" : "Terminals";

  return (
    <div className="tabs-strip" role="tablist" aria-label={ariaLabel}>
      <div className="tabs-strip__scroll" ref={scrollRef}>
        {sessions.length === 0 && !isAgent ? (
          <span className="tabs-strip__empty">No terminals — open one with +</span>
        ) : null}
        {sessions.map((s) => {
          const active = s.id === activeSessionId;
          const closeable = s.slot !== "m";
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-active={active}
              data-closeable={closeable ? "true" : undefined}
              className="tab"
              onClick={() => setActiveSession(s.id)}
              style={{ position: "relative", flexShrink: 0 }}
            >
              {active ? (
                <motion.span
                  layoutId={`tab-indicator-${kind}`}
                  style={{
                    position: "absolute",
                    bottom: -1,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: "var(--fg-muted)",
                    borderRadius: 1,
                  }}
                />
              ) : null}
              <span style={{ position: "relative", zIndex: 1 }}>{s.label}</span>
              {closeable ? (
                <span
                  role="button"
                  aria-label={`Close ${s.label}`}
                  className="tab__close"
                  onClick={(e) => { e.stopPropagation(); setCloseTarget(s); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setCloseTarget(s); } }}
                  tabIndex={-1}
                  style={{ position: "relative", zIndex: 1 }}
                >
                  ×
                </span>
              ) : null}
            </button>
          );
        })}
        <button
          type="button"
          className="tab tab--new"
          aria-label={isAgent ? "New agent" : "New terminal"}
          onClick={() => setNewOpen(true)}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="tabs-strip__tools">
        <div className="tabs-strip__zoom" aria-label="Terminal zoom">
          <span className="tabs-strip__zoom-label">Aa</span>
          <button type="button" className="tab tab--icon" aria-label="Decrease terminal font" onClick={() => bumpTerminalFont(-0.05)}>
            <Minus size={11} />
          </button>
          <button type="button" className="tab tab--icon" aria-label="Increase terminal font" onClick={() => bumpTerminalFont(0.05)}>
            <Plus size={11} />
          </button>
        </div>
        <div className="tabs-strip__fs">
          <button
            type="button"
            className={`tab tab--icon${fsActive ? " tab--fs-active" : ""}`}
            aria-label={fsActive ? "Exit fullscreen" : "Fullscreen"}
            aria-pressed={fsActive}
            title={fsActive ? "Exit fullscreen" : "Fullscreen"}
            onClick={() => setWorkspacePaneFullscreen(fsActive ? null : fsTarget)}
          >
            {fsActive ? (
              <Minimize2 size={13} strokeWidth={2} aria-hidden />
            ) : (
              <Maximize2 size={13} strokeWidth={2} aria-hidden />
            )}
          </button>
        </div>
      </div>

      {isAgent ? (
        <NewTabDialog
          open={newOpen}
          api={api}
          worktreeId={worktreeId ?? ""}
          onClose={() => setNewOpen(false)}
          onCreated={() => {}}
        />
      ) : (
        <NewTerminalDialog
          open={newOpen}
          api={api}
          worktreeId={worktreeId ?? ""}
          onClose={() => setNewOpen(false)}
          onCreated={() => {}}
        />
      )}

      <ConfirmDialog
        open={!!closeTarget}
        title={isAgent ? "Close agent" : "Close terminal"}
        message={isAgent ? "Close this agent session?" : "Close this terminal?"}
        confirmLabel="Close"
        onCancel={() => setCloseTarget(null)}
        onConfirm={() => {
          if (closeTarget) void api.deleteSession(closeTarget.id).then(() => void refreshTabs());
          setCloseTarget(null);
        }}
      />
    </div>
  );
}
