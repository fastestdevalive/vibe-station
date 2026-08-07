import { Plus } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { applySortOrder, useWorkspaceStore, type WorkspacePaneFullscreen } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { NewTabDialog } from "@/components/dialogs/NewTabDialog";
import { NewTerminalDialog } from "@/components/dialogs/NewTerminalDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { PaneTools } from "@/components/layout/PaneTools";

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

interface SortableTabProps {
  id: string;
  children: (opts: {
    setNodeRef: (el: HTMLElement | null) => void;
    style: CSSProperties;
    attributes: ReturnType<typeof useSortable>["attributes"];
    listeners: ReturnType<typeof useSortable>["listeners"];
    isDragging: boolean;
  }) => ReactNode;
}

/**
 * Drag-reorder wrapper for a single tab.
 *
 * IMPORTANT (AGENTS.md TerminalPane invariant): this wraps the tab *button*
 * itself — no extra DOM node — and only ever changes `transform`/`transition`
 * CSS via dnd-kit, never React tree position. The tab strip never renders
 * TerminalPane/ChatPane directly (Workspace.tsx renders those once, outside
 * this list, driven by `activeSessionId`), so even a full remount of a tab
 * button here cannot tear down a terminal stream — but we still key strictly
 * by session id and avoid index-based keys/positions, matching the invariant
 * for future callers that copy this pattern into a pane-bearing list.
 */
function SortableTab({ id, children }: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return children({ setNodeRef, style, attributes, listeners, isDragging });
}

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

  // --- Prototype-only tab reordering + rename (no daemon persistence yet) ---
  const sortScopeKey = `tabs:${kind}:${scope}:${worktreeId ?? "none"}`;
  const sortOrders = useWorkspaceStore((s) => s.sortOrders);
  const setSortOrder = useWorkspaceStore((s) => s.setSortOrder);
  const sessionNameOverrides = useWorkspaceStore((s) => s.sessionNameOverrides);
  const setSessionNameOverride = useWorkspaceStore((s) => s.setSessionNameOverride);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select();
  }, [renamingId]);

  function labelFor(s: Session): string {
    return sessionNameOverrides[s.id] ?? s.label;
  }

  function startRename(s: Session) {
    setRenamingId(s.id);
    setRenameValue(labelFor(s));
  }

  function commitRename() {
    if (renamingId) {
      const trimmed = renameValue.trim();
      if (trimmed) setSessionNameOverride(renamingId, trimmed.slice(0, 60));
    }
    setRenamingId(null);
  }

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
  // Reorder purely by re-sorting this array before render — sessions stay
  // keyed by `s.id` in the .map() below, so this never causes a remount of
  // anything (and TabsStrip doesn't render TerminalPane/ChatPane itself
  // anyway — see SortableTab's doc comment).
  const orderedSessions = useMemo(() => {
    const ids = sessions.map((s) => s.id);
    const ordered = applySortOrder(sortOrders[sortScopeKey], ids);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return ordered.map((id) => byId.get(id)!).filter(Boolean);
  }, [sessions, sortOrders, sortScopeKey]);

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = orderedSessions.map((s) => s.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const next = ids.slice();
    next.splice(from, 1);
    next.splice(to, 0, String(active.id));
    setSortOrder(sortScopeKey, next);
  }

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

  const ariaLabel = isAgent ? "Agent sessions" : "Terminals";

  return (
    <div className="tabs-strip" role="tablist" aria-label={ariaLabel}>
      <div className="tabs-strip__scroll" ref={scrollRef}>
        {sessions.length === 0 && !isAgent ? (
          <span className="tabs-strip__empty">No terminals — open one with +</span>
        ) : null}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={orderedSessions.map((s) => s.id)}
            strategy={horizontalListSortingStrategy}
          >
            {orderedSessions.map((s) => {
              const active = s.id === activeSessionId;
              const closeable = s.slot !== "m";
              const label = labelFor(s);
              const isRenaming = renamingId === s.id;
              return (
                <SortableTab key={s.id} id={s.id}>
                  {({ setNodeRef, style, attributes, listeners }) => (
                    <button
                      ref={setNodeRef}
                      {...attributes}
                      {...listeners}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-active={active}
                      data-closeable={closeable ? "true" : undefined}
                      className="tab"
                      onClick={() => { if (!isRenaming) setActiveSession(s.id); }}
                      onDoubleClick={(e) => { e.stopPropagation(); startRename(s); }}
                      style={{ position: "relative", flexShrink: 0, ...style }}
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
                        {isRenaming ? (
                          <input
                            ref={renameInputRef}
                            className="tab__rename-input"
                            value={renameValue}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                            onPointerDown={(e) => e.stopPropagation()}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                              if (e.key === "Escape") { e.preventDefault(); setRenamingId(null); }
                            }}
                            maxLength={60}
                            style={{ font: "inherit", width: `${Math.max(4, renameValue.length)}ch` }}
                          />
                        ) : (
                          label
                        )}
                        {isAgent ? (
                          <span
                            className="tab__channel-icon"
                            aria-hidden
                            title={s.channel === "json" ? "Rich Chat agent (json based)" : "Terminal agent"}
                          >
                            {s.channel === "json" ? "💬" : "⌨"}
                          </span>
                        ) : null}
                      </span>
                      {closeable ? (
                        <span
                          role="button"
                          aria-label={`Close ${label}`}
                          className="tab__close"
                          onClick={(e) => { e.stopPropagation(); setCloseTarget(s); }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setCloseTarget(s); } }}
                          tabIndex={-1}
                          style={{ position: "relative", zIndex: 1 }}
                        >
                          ×
                        </span>
                      ) : null}
                    </button>
                  )}
                </SortableTab>
              );
            })}
          </SortableContext>
        </DndContext>
        <button
          type="button"
          className="tab tab--new"
          aria-label={isAgent ? "New agent" : "New terminal"}
          onClick={() => setNewOpen(true)}
        >
          <Plus size={14} />
        </button>
      </div>
      <PaneTools fsTarget={fsTarget} onCloseDock={!isAgent ? () => toggleTerminalDock() : undefined} />

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
