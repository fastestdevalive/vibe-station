import { Plus } from "lucide-react";
import { motion } from "framer-motion";
import { createPortal } from "react-dom";
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
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { sessionLabel } from "@/lib/sessionLabel";
import { computeNewSortOrder, useWorkspaceStore, type WorkspacePaneFullscreen } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useDragClickGuard } from "@/hooks/useDragClickGuard";
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

/** How long after a long-press OPENS the reset menu a subsequent `contextmenu`
 *  event (fired independently by the browser's own long-press detector on
 *  some touch devices) is treated as a direct consequence of the same
 *  press-and-release gesture, rather than a genuine second interaction —
 *  see `lastMenuOpenedAt` in `TabsStrip` for the trailing-`click` half of
 *  this same problem. */
const MENU_REOPEN_GUARD_MS = 400;

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
 *
 * IMPORTANT: dnd-kit's `activationConstraint.distance` only gates whether a
 * *drag* starts — it does NOT stop the browser from firing a `click` on the
 * tab when the pointer is released, no matter how far it moved in between.
 * Left unhandled, that trailing click would ALSO activate the dragged tab.
 * `useDragClickGuard` (wired into the `DndContext` below via `markDrag`)
 * cancels it from a `window`-capture listener — see that hook for why this
 * cannot be done from the tab's own `onClick`.
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
  const [terminateTarget, setTerminateTarget] = useState<Session | null>(null);

  // --- Reset (+handoff) with confirmation (Part 03 Phase 3) ---
  // Mirrors `terminateTarget`'s existing pattern exactly: a "pending destructive
  // action" target that gates a shared `ConfirmDialog`, only firing the real
  // API call on confirm, never on the initial click/menu-item selection.
  const [resetMenu, setResetMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [resetTarget, setResetTarget] = useState<Session | null>(null);
  const [resetHandoff, setResetHandoff] = useState(false);

  useEffect(() => {
    if (!resetMenu) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-tab-menu-panel]")) return;
        setResetMenu(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setResetMenu(null);
      }
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
      removeListeners = () => {
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("keydown", onKey);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListeners?.();
    };
  }, [resetMenu]);

  // --- Tab reordering + rename: real daemon endpoints (Part 03 Phase 2) ---
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  /** Cancels the browser's trailing `click` after a drag-to-reorder, which
   *  would otherwise activate the dragged tab. Same guard LeftSidebar uses. */
  const markDrag = useDragClickGuard();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select();
  }, [renamingId]);

  // --- Long-press (touch) opens the same reset menu as right-click ---
  // (Decision 6). The timer MUST be cleared on pointerup, pointercancel,
  // pointermove-past-slop AND dnd-kit's onDragStart — missing any one of
  // them would fire the menu mid-drag.
  const pressTimer = useRef<number | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  /** Timestamp (performance.now()) of the most recent time the LONG-PRESS
   *  TIMER opened the menu. Deliberately NOT stamped by `onContextMenu`'s own
   *  open branch — a real mouse right-click/right-click toggle (2.T2b) must
   *  still be able to close a menu it just opened itself; only a long-press
   *  open needs protecting. A long-press that opens the menu is immediately
   *  followed by two physical consequences of the very same gesture: the
   *  browser's trailing `click` when the finger lifts (suppressed below via
   *  `markDrag`, since that's exactly the "trailing click after a pointer
   *  interaction" case it already exists for), and on some Android/Chrome
   *  builds, a native `contextmenu` event fired by the browser's own
   *  long-press detector. The latter isn't a `click`, so `markDrag`'s
   *  click-only guard can't catch it; `onContextMenu` below instead checks
   *  this timestamp and refuses to undo a just-opened menu within
   *  `MENU_REOPEN_GUARD_MS`. */
  const lastMenuOpenedAt = useRef(0);
  function cancelPress() {
    if (pressTimer.current != null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressOrigin.current = null;
  }

  function startRename(s: Session) {
    cancelPress();
    setRenamingId(s.id);
    setRenameValue(sessionLabel(s));
  }

  function commitRename() {
    const id = renamingId;
    setRenamingId(null);
    if (!id) return;
    // Unconditional: an empty submission is a valid request to clear the
    // name back to the server's computed default (name -> null), not a
    // silent no-op — matches the rename endpoint's contract.
    const trimmed = renameValue.trim().slice(0, 60);
    void api
      .renameSession(id, trimmed)
      .catch(() => {
        /* surface errors later */
      })
      .then(() => refreshTabs());
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
  // Reorder purely by re-sorting this array before render, by each session's
  // REAL server `sortOrder` — sessions stay keyed by `s.id` in the .map()
  // below, so this never causes a remount of anything (and TabsStrip doesn't
  // render TerminalPane/ChatPane itself anyway — see SortableTab's doc comment).
  const orderedSessions = useMemo(() => {
    return sessions
      .filter((s) => s.supersededBy == null)
      .sort((a, b) => {
        const ao = a.sortOrder ?? 0;
        const bo = b.sortOrder ?? 0;
        if (ao !== bo) return ao - bo;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }, [sessions]);

  /** Optimistically patch a session's `sortOrder` in whichever local store
   *  backs this scope, so the reorder is reflected immediately (before the
   *  server call resolves) without waiting on a WS round-trip. */
  function patchLocalSortOrder(sessionId: string, sortOrder: number | undefined) {
    if (isProject) {
      useServerStore.getState().applySessionUpdated(sessionId, { sortOrder });
    } else {
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, sortOrder } : s)));
    }
  }

  function handleDragEnd(e: DragEndEvent) {
    // Mark BEFORE the early return: a drag that ends where it started still
    // produces the trailing click that would activate the dragged tab.
    markDrag();
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = orderedSessions.findIndex((s) => s.id === String(active.id));
    const to = orderedSessions.findIndex((s) => s.id === String(over.id));
    if (from === -1 || to === -1) return;
    const moved = orderedSessions[from]!;
    const prevSortOrder = moved.sortOrder;

    // Simulate the drop to find the moved item's new neighbors, then compute
    // its new fractional sortOrder from their REAL sortOrder values (Decision 1).
    const reordered = orderedSessions.slice();
    reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    const newIndex = reordered.indexOf(moved);
    const prevNeighbor = reordered[newIndex - 1];
    const nextNeighbor = reordered[newIndex + 1];
    const newSortOrder = computeNewSortOrder(prevNeighbor?.sortOrder, nextNeighbor?.sortOrder);

    patchLocalSortOrder(moved.id, newSortOrder);
    void api.reorderSession(moved.id, newSortOrder).catch(() => {
      patchLocalSortOrder(moved.id, prevSortOrder);
    });
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

  /** Sessions announced by `session:created` while a `listSessions` fetch was
   *  in flight. See `mergeArrivedDuringFetch` below — without this, the fetch's
   *  older snapshot overwrites them and the tab never appears. */
  const arrivedDuringFetch = useRef<Session[]>([]);

  useEffect(() => {
    if (isProject) return; // project scope derives from the server store above
    if (!worktreeId) {
      setSessions([]);
      setSessionsLoaded(true);
      return;
    }
    setSessionsLoaded(false);
    const matches = (s: Session) => s.type === kind;
    arrivedDuringFetch.current = [];
    void (async () => {
      const all = await api.listSessions(worktreeId);
      // Union, never blind-replace. `session:created` can fire while this GET
      // is in flight, and the server snapshot it returns may predate the new
      // session — so `setSessions(ss)` alone silently drops a tab that was
      // already announced, and nothing ever invalidates it. That is the
      // "second agent session sometimes doesn't show up in the tab bar" bug;
      // it is a lost update, not slowness, so it survives any latency fix (a
      // slow daemon just widens the window from microseconds to seconds).
      const ss = [
        ...all.filter(matches),
        ...arrivedDuringFetch.current.filter(
          (s) => matches(s) && !all.some((a) => a.id === s.id),
        ),
      ];
      arrivedDuringFetch.current = [];
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
      const main = isAgent ? ss.find((s) => s.isMain) : undefined;
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
      // Also record it for the in-flight fetch to merge in — appending to
      // state alone is not enough, because a `listSessions` response that is
      // still in flight will replace this array wholesale when it lands.
      arrivedDuringFetch.current = [
        ...arrivedDuringFetch.current.filter((s) => s.id !== ev.snapshot!.id),
        ev.snapshot,
      ];
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

    // Live reconciliation for fields the daemon broadcasts on `session:updated`
    // (name, archivedAt, sortOrder, pinnedAt, channel) — project scope already
    // gets this via the global `useServerSync`/`useServerStore` path; this
    // worktree-scoped `localSessions` list needs its own patch so e.g. a
    // reset's `archivedAt` shows up here without a manual refresh (3.T3).
    const offUpdated = api.on("session:updated", (ev) => {
      if (ev.type !== "session:updated") return;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== ev.sessionId) return s;
          const patch: Partial<Session> = {};
          if (ev.name !== undefined) patch.name = ev.name ?? null;
          if (ev.archivedAt !== undefined) patch.archivedAt = ev.archivedAt ?? null;
          if (ev.sortOrder !== undefined) patch.sortOrder = ev.sortOrder;
          if (ev.pinnedAt !== undefined) patch.pinnedAt = ev.pinnedAt ?? null;
          if (ev.supersededBy !== undefined) patch.supersededBy = ev.supersededBy ?? null;
          if (ev.channel !== undefined) {
            patch.channel = ev.channel;
            patch.useTmux = ev.channel === "tmux";
          }
          return { ...s, ...patch };
        }),
      );
      // The superseded session's tab is about to disappear from
      // orderedSessions — if it was the active one, follow it to its
      // replacement instead of leaving the strip with no selected tab
      // (mirrors the session:deleted handler above).
      if (ev.supersededBy) {
        const st = useWorkspaceStore.getState();
        const cur = isAgent ? st.activeSessionId : st.activeTerminalSessionId;
        if (cur === ev.sessionId) setActiveSession(ev.supersededBy);
      }
    });

    return () => {
      offCreated();
      offDeleted();
      offUpdated();
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => {
            markDrag();
            cancelPress();
          }}
          onDragCancel={markDrag}
          onDragEnd={handleDragEnd}
          modifiers={[restrictToHorizontalAxis]}
        >
          <SortableContext
            items={orderedSessions.map((s) => s.id)}
            strategy={horizontalListSortingStrategy}
          >
            {orderedSessions.map((s) => {
              const active = s.id === activeSessionId;
              const closeable = !s.isMain;
              const label = sessionLabel(s);
              const isRenaming = renamingId === s.id;
              const archived = s.archivedAt != null;
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
                      data-archived={archived ? "true" : undefined}
                      className="tab"
                      onClick={() => {
                        if (!isRenaming) setActiveSession(s.id);
                      }}
                      onDoubleClick={(e) => { e.stopPropagation(); startRename(s); }}
                      onContextMenu={(e) => {
                        if (!isAgent) return;
                        e.preventDefault();
                        e.stopPropagation();
                        // Read from the event in the handler body — the updater
                        // below only ever sees a plain captured value, so it's
                        // safe for React to invoke it more than once (Decision 7).
                        const point = { x: e.clientX, y: e.clientY };
                        setResetMenu((prev) => {
                          if (prev?.session.id === s.id) {
                            // A native `contextmenu` fired by the browser's own
                            // long-press detector shortly after OUR long-press
                            // TIMER already opened this same session's menu is
                            // a physical echo of the same gesture, not a request
                            // to close it. `lastMenuOpenedAt` is only stamped by
                            // the long-press timer (below), never here, so a
                            // deliberate right-click-right-click toggle (2.T2b)
                            // is never guarded against itself.
                            if (performance.now() - lastMenuOpenedAt.current < MENU_REOPEN_GUARD_MS) {
                              return prev;
                            }
                            return null;
                          }
                          return { session: s, ...point };
                        });
                      }}
                      onPointerDown={(e) => {
                        // dnd-kit's own listener still needs to run so drag
                        // activation keeps working — {...listeners} above is
                        // overridden by this explicit prop, so it must be
                        // invoked manually here.
                        listeners?.onPointerDown?.(e);
                        if (e.pointerType === "mouse" || !isAgent) return;
                        pressOrigin.current = { x: e.clientX, y: e.clientY };
                        const point = { x: e.clientX, y: e.clientY };
                        pressTimer.current = window.setTimeout(() => {
                          // The finger lifting right after this fires dispatches
                          // a trailing `click` on the tab — mark it now (not from
                          // onPointerUp) so the guard window comfortably covers
                          // the near-instant gap between "timer fires" and
                          // "finger lifts + click dispatches", regardless of
                          // exactly when the pointerup itself lands. Without
                          // this, that trailing click hits the outside-click
                          // handler below and immediately closes the menu we
                          // just opened.
                          markDrag();
                          lastMenuOpenedAt.current = performance.now();
                          setResetMenu({ session: s, ...point });
                        }, 500);
                      }}
                      onPointerMove={(e) => {
                        listeners?.onPointerMove?.(e);
                        if (!pressOrigin.current) return;
                        const dx = e.clientX - pressOrigin.current.x;
                        const dy = e.clientY - pressOrigin.current.y;
                        if (Math.hypot(dx, dy) > 10) cancelPress();
                      }}
                      onPointerUp={(e) => {
                        listeners?.onPointerUp?.(e);
                        cancelPress();
                      }}
                      onPointerCancel={(e) => {
                        listeners?.onPointerCancel?.(e);
                        cancelPress();
                      }}
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
                        {archived ? (
                          <span className="tab__archived-badge" title="This session has been archived">
                            Archived
                          </span>
                        ) : null}
                      </span>
                      {closeable ? (
                        <span
                          role="button"
                          aria-label={`Terminate ${label}`}
                          className="tab__close"
                          onClick={(e) => { e.stopPropagation(); setTerminateTarget(s); }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setTerminateTarget(s); } }}
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
        open={!!terminateTarget}
        title={isAgent ? "Terminate agent?" : "Terminate terminal?"}
        message={isAgent ? "Terminate this agent session?" : "Terminate this terminal?"}
        confirmLabel="Terminate"
        onCancel={() => setTerminateTarget(null)}
        onConfirm={() => {
          if (terminateTarget) void api.terminateSession(terminateTarget.id).then(() => void refreshTabs());
          setTerminateTarget(null);
        }}
      />

      {resetMenu
        ? createPortal(
            <div
              className="menu-pop"
              data-tab-menu-panel
              role="menu"
              aria-label="Session actions"
              style={{
                position: "fixed",
                top: resetMenu.y + 6,
                left: Math.max(
                  8,
                  Math.min(
                    resetMenu.x,
                    typeof window !== "undefined" ? window.innerWidth - 178 : 8,
                  ),
                ),
                minWidth: 150,
                zIndex: 4000,
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item"
                onClick={(e) => {
                  e.stopPropagation();
                  setResetTarget(resetMenu.session);
                  setResetHandoff(false);
                  setResetMenu(null);
                }}
              >
                Reset
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item"
                onClick={(e) => {
                  e.stopPropagation();
                  setResetTarget(resetMenu.session);
                  setResetHandoff(true);
                  setResetMenu(null);
                }}
              >
                Reset with handoff
              </button>
            </div>,
            document.body,
          )
        : null}

      {/* Mirrors `terminateTarget`'s ConfirmDialog above (Decision 3) — same
          shared component, reset-specific copy. `resetSession` is only ever
          called from `onConfirm`, never from the menu-item click above. */}
      <ConfirmDialog
        open={!!resetTarget}
        title={resetHandoff ? "Reset with handoff" : "Reset session"}
        message="Resetting ends the current chat and starts a fresh session in its place. This can't be undone."
        confirmLabel="Reset"
        onCancel={() => setResetTarget(null)}
        onConfirm={() => {
          const target = resetTarget;
          const handoff = resetHandoff;
          setResetTarget(null);
          if (target) {
            void api
              .resetSession(target.id, { handoff })
              .catch(() => {
                /* surface errors later */
              })
              .then(() => refreshTabs());
          }
        }}
      />
    </div>
  );
}
