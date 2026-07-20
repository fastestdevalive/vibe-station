import { Maximize2, Minimize2, Minus, Plus, X } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { useWorkspaceStore, type WorkspacePaneFullscreen } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { NewTabDialog } from "@/components/dialogs/NewTabDialog";
import { NewTerminalDialog } from "@/components/dialogs/NewTerminalDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";

type TabKind = "agent" | "terminal";

interface TabsStripProps {
  api: ApiInstance;
  /** Context id: worktree id (scope="worktree") or project id (scope="project"). */
  worktreeId: string | null;
  /** "agent" → agent pane tabs; "terminal" → bottom dock terminal tabs. */
  kind: TabKind;
  /** "project" → direct-session terminals (no worktree), derived from the
   *  server store and created in the project base dir. Default "worktree". */
  scope?: "worktree" | "project";
}

/** Contexts with an auto-create request in flight. Guards the window between
 *  "decided to create" and "server knows about it", where a fresh strip would
 *  still read zero terminals and create a second one. Held only for that
 *  window — see the release comment below. Module-scoped so it survives a
 *  remount (StrictMode's double-effect is covered by the per-instance ref). */
const autoCreateInFlight = new Set<string>();

export function TabsStrip({ api, worktreeId, kind, scope = "worktree" }: TabsStripProps) {
  const isAgent = kind === "agent";
  const isProject = scope === "project";
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
  const toggleTerminalDock = useWorkspaceStore((s) => s.toggleTerminalDock);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Context key ("scope:id") this instance already tried to auto-create for.
   *  Keyed by context, not just "did it run": the strip is NOT remounted when
   *  the user switches worktrees (same tree position, new props), so a plain
   *  boolean would let the first empty worktree suppress every later one.
   *  Closing the last tab keeps the key, so it does not re-trigger. */
  const autoCreateAttemptedFor = useRef<string | null>(null);

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
  const [localSessions, setSessions] = useState<Session[]>([]);
  /** Worktree list finished (project scope is always ready from the server store). */
  const [sessionsLoaded, setSessionsLoaded] = useState(isProject);
  const [newOpen, setNewOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<Session | null>(null);

  // Project scope: direct-session terminals live in the global server store
  // (no worktree). Derive them instead of fetching per-worktree.
  const serverSessions = useServerStore((s) => s.sessions);
  const projectSessions = useMemo(
    () =>
      isProject && worktreeId
        ? serverSessions.filter(
            (s) => s.projectId === worktreeId && s.worktreeId === null && s.type === kind,
          )
        : [],
    [isProject, worktreeId, serverSessions, kind],
  );
  const sessions = isProject ? projectSessions : localSessions;

  // Project scope: keep the active terminal selection valid as direct sessions
  // come and go (created/closed elsewhere). Pick a default when none is active.
  useEffect(() => {
    if (!isProject) return;
    const store = useWorkspaceStore.getState();
    const cur = isAgent ? store.activeSessionId : store.activeTerminalSessionId;
    if (cur && projectSessions.some((s) => s.id === cur)) return;
    const pick = projectSessions[0]?.id ?? null;
    if (pick) setActiveSession(pick);
  }, [isProject, projectSessions, isAgent, setActiveSession]);

  useEffect(() => {
    if (isProject) return; // project scope derives from the server store above
    if (!worktreeId) {
      setSessions([]);
      setSessionsLoaded(true);
      return;
    }
    setSessionsLoaded(false);
    const matches = (s: Session) => s.type === kind;
    void (async () => {
      const all = await api.listSessions(worktreeId);
      const ss = all.filter(matches);
      setSessions(ss);
      setSessionsLoaded(true);
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
  }, [api, worktreeId, kind, isAgent, isProject, setActiveSession]);

  // Opening an empty terminal dock creates one shell immediately (no dialog).
  // Fires at most once per context (worktree/project): the dock is unmounted
  // while hidden, so "mounted empty" == "opened empty". Closing the last tab
  // while the dock stays open keeps the attempted-key set, so it does not
  // re-trigger; switching to another empty worktree does.
  useEffect(() => {
    if (isAgent || !worktreeId || !sessionsLoaded || sessions.length > 0) return;

    const lockKey = `${scope}:${worktreeId}`;
    if (autoCreateAttemptedFor.current === lockKey) return;
    if (autoCreateInFlight.has(lockKey)) {
      autoCreateAttemptedFor.current = lockKey;
      return;
    }
    autoCreateAttemptedFor.current = lockKey;
    autoCreateInFlight.add(lockKey);

    let cancelled = false;
    void (async () => {
      try {
        if (isProject) {
          const existing = useServerStore
            .getState()
            .sessions.some(
              (s) => s.projectId === worktreeId && s.worktreeId === null && s.type === "terminal",
            );
          if (existing || cancelled) return;
          await api.createDirectSession({
            target: "direct",
            projectId: worktreeId,
            type: "terminal",
            useTmux: true,
          });
        } else {
          const all = await api.listSessions(worktreeId);
          if (cancelled || all.some((s) => s.type === "terminal")) return;
          let name: string | undefined;
          try {
            name = await api.nextTerminalName(worktreeId);
          } catch {
            name = undefined;
          }
          if (cancelled) return;
          await api.createSession({
            worktreeId,
            modeId: null,
            type: "terminal",
            name,
            useTmux: true,
          });
        }
      } catch {
        // Leave the empty hint; allow a later dock open to retry.
        autoCreateAttemptedFor.current = null;
      } finally {
        // Always release: the key guards only the in-flight window, where a
        // racing strip would not yet see the new session. Once the create has
        // resolved, a racing strip re-reads the server / store and bails on its
        // own. Holding the key past that point would strand it forever if this
        // strip unmounts before the session lands.
        autoCreateInFlight.delete(lockKey);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, isAgent, isProject, scope, sessions.length, sessionsLoaded, worktreeId]);

  async function refreshTabs() {
    // Project scope derives from the server store (WS session:deleted updates
    // it); nothing to refetch here.
    if (isProject || !worktreeId) return;
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
              <span style={{ position: "relative", zIndex: 1 }}>
                {s.label}
                {isAgent ? (
                  <span
                    className="tab__channel-icon"
                    aria-hidden
                    title={s.channel === "json" ? "JSON chat agent" : "Terminal agent"}
                  >
                    {s.channel === "json" ? "💬" : "⌨"}
                  </span>
                ) : null}
              </span>
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
        {!isAgent ? (
          <button
            type="button"
            className="tab tab--icon tool-bar-btn"
            aria-label="Close terminal dock"
            title="Close terminal dock"
            onClick={() => toggleTerminalDock()}
          >
            <X size={13} aria-hidden />
          </button>
        ) : null}
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
          scope={scope}
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
