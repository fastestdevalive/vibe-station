import { Check, ChevronDown, ChevronRight, EyeOff, Filter, FolderTree, Moon, MoreHorizontal, Pin, Plus, SlidersHorizontal, Type } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ApiInstance } from "@/api";
import type { Project, Session, SessionState, Worktree } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useLayout } from "@/hooks/useLayout";
import { useSubscription } from "@/hooks/useSubscription";
import { StatusDot } from "@/components/layout/StatusDot";
import { worktreeRolledUpStatus } from "@/lib/worktreeStatus";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { NewSessionDialog } from "@/components/dialogs/NewSessionDialog";
import { Logo } from "@/components/shared/Logo";

/** First 3 characters for collapsed rail labels (trimmed, min 1 char). */
function abbrevLabel(name: string): string {
  const t = name.trim();
  if (t.length === 0) return "—";
  return t.slice(0, 3);
}

/** When several siblings share the same 3-letter prefix, suffix from id for a stable unique chip. */
function disambiguatedAbbrev(
  name: string,
  id: string,
  peers: readonly { id: string; name: string }[],
): string {
  const base = abbrevLabel(name);
  const dup = peers.filter((p) => abbrevLabel(p.name) === base);
  if (dup.length <= 1) return base;
  const tail =
    id.replace(/[^a-zA-Z0-9]/g, "").slice(-1) ||
    id.slice(-1) ||
    "?";
  const stem = base.replace(/[-–—.]$/u, "").slice(0, 2);
  return `${stem}${tail}`.slice(0, 3);
}

function worktreeIsInactive(sessions: Session[], live: Record<string, SessionState | undefined>): boolean {
  const agents = sessions.filter((s) => s.type === "agent");
  if (agents.length === 0) return true;
  // "Hide done" hides only worktrees the user explicitly marked done — NOT
  // `exited`. Exited is involuntary (agent crashed, tmux pane died, or the
  // tmux server was lost on reboot), and after a restart every session lands
  // in `exited`. Folding it in here hid all previously-active worktrees behind
  // a filter labelled "done", so keep exited visible.
  return agents.every((s) => {
    const st = live[s.id] ?? s.state;
    return st === "done";
  });
}

interface LeftSidebarProps {
  api: ApiInstance;
  /** Narrow desktop rail: abbreviated labels + compact controls */
  collapsed?: boolean;
  /** Mobile drawer: show pinned brand link at top */
  isMobile?: boolean;
  onWorktreeSelected?: (wtId: string) => void;
}

export function LeftSidebar({
  api,
  collapsed = false,
  isMobile = false,
  onWorktreeSelected,
}: LeftSidebarProps) {
  const location = useLocation();
  const { theme, toggleTheme, toggleFont } = useTheme();
  // Server data comes from the central store, populated and refreshed by
  // `useServerSync` (mounted once in Workspace). LeftSidebar derives the
  // by-project / by-worktree maps it needs from those flat arrays — keeping
  // a single source of truth instead of mirroring it into local state.
  const projects = useServerStore((s) => s.projects);
  const worktrees = useServerStore((s) => s.worktrees);
  const sessions = useServerStore((s) => s.sessions);
  const worktreeMap = useMemo(() => {
    const m: Record<string, Worktree[]> = {};
    for (const w of worktrees) (m[w.projectId] ??= []).push(w);
    return m;
  }, [worktrees]);
  const sessionMap = useMemo(() => {
    const m: Record<string, Session[]> = {};
    for (const s of sessions) (m[s.worktreeId] ??= []).push(s);
    return m;
  }, [sessions]);
  /** Project lookup for the project-name subheader on pinned rows. */
  const projectById = useMemo(() => {
    const m: Record<string, Project> = {};
    for (const p of projects) m[p.id] = p;
    return m;
  }, [projects]);
  /** Ids of hidden projects — their rows + all their worktrees are filtered out
   *  of the sidebar everywhere (projects list AND pinned section). */
  const hiddenProjectIds = useMemo(
    () => new Set(projects.filter((p) => p.hidden).map((p) => p.id)),
    [projects],
  );
  /** Visible (non-hidden) projects — the only ones rendered in the tree. */
  const visibleProjects = useMemo(
    () => projects.filter((p) => !p.hidden),
    [projects],
  );
  /**
   * Pinned worktrees in display order: ISO timestamp DESC (newest pinned first).
   * Filter out anything no longer present on the server (defense-in-depth — the
   * server-side delete naturally removes pinned worktrees, but a stale id from
   * an in-flight event shouldn't crash render) and any worktree of a hidden project.
   */
  const pinnedWorktrees = useMemo(
    () =>
      worktrees
        .filter((w) => w.pinnedAt != null && !hiddenProjectIds.has(w.projectId))
        .slice()
        .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "")),
    [worktrees, hiddenProjectIds],
  );
  const [openProj, setOpenProj] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("sidebar:openProj");
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set<string>();
  });

  const { activeWorktreeId, activeProjectId, activeSessionId, setActiveWorktree } = useLayout();
  const clearWorkspaceSelection = useWorkspaceStore((s) => s.clearWorkspaceSelection);
  const setMobileSidebarOpen = useWorkspaceStore((s) => s.setMobileSidebarOpen);
  const mobileSidebarOpen = useWorkspaceStore((s) => s.mobileSidebarOpen);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const hideInactiveWorktrees = useWorkspaceStore((s) => s.hideInactiveWorktrees);
  const toggleInactiveWorktreesFilter = useWorkspaceStore((s) => s.toggleInactiveWorktreesFilter);

  const [newSessProject, setNewSessProject] = useState<Project | null>(null);
  const [wtMenu, setWtMenu] = useState<{ projectId: string; worktree: Worktree; rect: DOMRect } | null>(null);
  const [projMenu, setProjMenu] = useState<{ project: Project; rect: DOMRect } | null>(null);

  /** Scroll container — used to snap the active worktree into view when the
   *  sidebar is reopened (see effect below). */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Whether the sidebar was visible on the previous render, to detect the
   *  hidden→visible (reopen) rising edge. Seeded to the current visibility so a
   *  mount with an already-open sidebar still snaps once. */
  const visible = isMobile ? mobileSidebarOpen : !collapsed;
  const prevVisibleRef = useRef<boolean>(!visible);
  const [filterMenuRect, setFilterMenuRect] = useState<DOMRect | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Worktree | null>(null);
  const [pendingDismiss, setPendingDismiss] = useState<Worktree | null>(null);

  // Subscribe to live session output for every session we know about so the
  // rollup picks up state transitions in real time. The set of ids comes from
  // the central store, recomputed cheaply via useMemo+sort+join.
  const sessionIdKey = useMemo(
    () => sessions.map((s) => s.id).sort().join(","),
    [sessions],
  );
  useSubscription(sessionIdKey ? sessionIdKey.split(",").filter(Boolean) : [], api);

  /** Close-on-outside must attach after the opening click finishes (same tap was closing the menu / breaking UI). */
  useEffect(() => {
    if (!wtMenu) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-wt-menu-panel]") || t.closest("[data-wt-menu-trigger]")) return;
        setWtMenu(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setWtMenu(null);
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
  }, [wtMenu]);

  useEffect(() => {
    if (!projMenu) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-proj-menu-panel]") || t.closest("[data-proj-menu-trigger]")) return;
        setProjMenu(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setProjMenu(null);
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
  }, [projMenu]);

  useEffect(() => {
    if (!filterMenuRect) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-filter-menu-panel]") || t.closest("[data-filter-menu-trigger]")) return;
        setFilterMenuRect(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setFilterMenuRect(null);
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
  }, [filterMenuRect]);

  async function confirmDeleteWorktree() {
    if (!pendingDelete) return;
    const worktree = pendingDelete;
    setPendingDelete(null);
    try {
      await api.deleteWorktree(worktree.id);
      if (activeWorktreeId === worktree.id) {
        clearWorkspaceSelection();
      }
      // Store stays current via the `worktree:deleted` WS event handled in
      // useServerSync — no manual refresh needed.
    } catch {
      /* surface errors later */
    }
  }

  async function confirmDismissWorktree() {
    if (!pendingDismiss) return;
    const worktree = pendingDismiss;
    setPendingDismiss(null);
    try {
      await api.dismissWorktree(worktree.id);
      if (activeWorktreeId === worktree.id) {
        clearWorkspaceSelection();
      }
    } catch {
      /* surface errors later */
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem("sidebar:openProj", JSON.stringify([...openProj]));
    } catch { /* ignore */ }
  }, [openProj]);

  useEffect(() => {
    if (!activeProjectId) return;
    setOpenProj((prev) => {
      if (prev.has(activeProjectId)) return prev;
      const next = new Set(prev);
      next.add(activeProjectId);
      return next;
    });
  }, [activeProjectId]);

  // When the sidebar is reopened (desktop collapse→expand, mobile drawer open),
  // snap the selected worktree into view if it scrolled out of sight. Only on
  // the hidden→visible rising edge so we never fight the user mid-scroll.
  // `block: "nearest"` self-no-ops when the row is already visible.
  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible || wasVisible) return undefined;

    let raf1 = 0;
    let raf2 = 0;
    let raf3 = 0;
    function snap(): boolean {
      const el = scrollRef.current?.querySelector<HTMLElement>('[data-active="true"]');
      if (!el) return false;
      // Guard: jsdom (test env) and very old browsers lack scrollIntoView.
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "nearest" });
      }
      return true;
    }
    // Double rAF: the expand changes width + swaps abbreviated→full labels +
    // the active project auto-expands in the same commit; wait for layout to
    // settle before measuring. Retry one more frame if the row isn't in the DOM
    // yet (auto-expand may not have inserted it).
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (!snap()) raf3 = window.requestAnimationFrame(snap);
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      window.cancelAnimationFrame(raf3);
    };
  }, [visible]);

  function toggleProj(id: string) {
    setOpenProj((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function selectWorktree(projectId: string, w: Worktree) {
    // Early-return if re-tapping the same worktree with an active session (defense-in-depth)
    if (w.id === activeWorktreeId && activeSessionId != null) {
      onWorktreeSelected?.(w.id);
      return;
    }
    setActiveWorktree(projectId, w.id, sessionMap[w.id]);
    onWorktreeSelected?.(w.id);
  }

  // A modified click (ctrl/cmd/shift/alt or non-primary button) lets React
  // Router's <Link> fall through to the browser's default "open in new tab"
  // behavior without in-app navigation. We must NOT call selectWorktree() in
  // that case, otherwise the current tab would also navigate to the worktree.
  function isModifiedClick(e: React.MouseEvent) {
    return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
  }

  const isSettings = location.pathname === "/settings";

  return (
    <div
      className={`left-sidebar ${collapsed ? "left-sidebar--collapsed" : ""}`}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      {isMobile ? (
        <Link
          to="/"
          className="left-sidebar__brand"
          aria-label="Home"
          onClick={() => {
            clearWorkspaceSelection();
            setMobileSidebarOpen(false);
          }}
          style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
        >
          <Logo />
          Vibe Station
        </Link>
      ) : null}
      <div
        ref={scrollRef}
        className="left-sidebar__scroll"
        style={{ flex: 1, overflow: "auto", padding: collapsed ? "var(--space-1)" : "var(--space-2)" }}
      >
        {!collapsed && pinnedWorktrees.length > 0 ? (
          <section className="pinned-section" aria-label="Pinned worktrees">
            <div className="sidebar-projects-heading pinned-section__heading">
              <span className="sidebar-projects-heading__gutter" aria-hidden />
              <span className="sidebar-projects-heading__title">Pinned</span>
            </div>
            {pinnedWorktrees.map((w) => {
              const proj = projectById[w.projectId];
              const isActive = activeWorktreeId === w.id && location.pathname.startsWith("/worktree/");
              return (
                <div key={`pinned-${w.id}`} className="wt-row-wrap">
                  <div
                    className="tree-row tree-row--worktree pinned-row"
                    data-active={isActive}
                    style={{ position: "relative" }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectWorktree(w.projectId, w);
                      }
                    }}
                  >
                    <Link
                      to={`/worktree/${w.id}`}
                      className="wt-row__stretch-link"
                      aria-label={`Open pinned worktree ${w.branch}`}
                      onClick={(e) => {
                        if (isModifiedClick(e)) return;
                        selectWorktree(w.projectId, w);
                      }}
                      tabIndex={-1}
                    />
                    <span className="wt-leading-slot pinned-row__leading" aria-hidden>
                      <StatusDot
                        status={worktreeRolledUpStatus(sessionMap[w.id] ?? [], sessionStates)}
                      />
                    </span>
                    <div className="pinned-row__text">
                      <span className="pinned-row__primary">{w.branch}</span>
                      <span className="pinned-row__subhead" title={proj?.path}>
                        {proj?.name ?? w.projectId}
                      </span>
                    </div>
                    <div className="wt-row__trail pinned-row__trail" style={{ position: "relative", zIndex: 2 }}>
                      <span className="wt-row__id" title={w.id}>
                        {w.id}
                      </span>
                      <button
                        type="button"
                        data-wt-menu-trigger
                        className="icon-btn wt-menu-trigger tree-row__action"
                        aria-label={`Worktree actions for ${w.branch}`}
                        aria-expanded={wtMenu?.worktree.id === w.id}
                        aria-haspopup="menu"
                        title="Worktree menu"
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          setWtMenu((prev) =>
                            prev?.worktree.id === w.id
                              ? null
                              : { projectId: w.projectId, worktree: w, rect },
                          );
                        }}
                      >
                        <MoreHorizontal size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}
        <div className="sidebar-projects-heading">
          <span className="sidebar-projects-heading__gutter" aria-hidden />
          {collapsed ? (
            <span className="sidebar-projects-heading__mark" title="Projects">
              <FolderTree size={15} aria-hidden />
            </span>
          ) : (
            <>
              <span className="sidebar-projects-heading__title">Projects</span>
              <button
                type="button"
                data-filter-menu-trigger
                className="icon-btn"
                title={hideInactiveWorktrees ? "Showing active only" : "Filter worktrees"}
                aria-label="Filter worktrees"
                aria-pressed={hideInactiveWorktrees}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setFilterMenuRect((r) => (r ? null : rect));
                }}
              >
                <Filter
                  size={13}
                  fill={hideInactiveWorktrees ? "currentColor" : "none"}
                  color={hideInactiveWorktrees ? "var(--accent-color, var(--fg-primary))" : undefined}
                />
              </button>
            </>
          )}
        </div>
        {visibleProjects.length === 0 ? (
          <div className={`empty-state ${collapsed ? "empty-state--collapsed-rail" : ""}`} style={{ padding: collapsed ? "var(--space-2)" : "var(--space-4)" }}>
            {collapsed ? (
              <span title="No projects yet — add one with the CLI">∅</span>
            ) : (
              "No projects yet. Add one with the CLI."
            )}
          </div>
        ) : null}
        {visibleProjects.map((p) => (
          <div key={p.id}>
            <div className="tree-row tree-row--project">
              <button
                type="button"
                className="tree-row__project-expand"
                aria-expanded={openProj.has(p.id)}
                aria-label={`${openProj.has(p.id) ? "Collapse" : "Expand"} project ${p.name}`}
                title={
                  collapsed
                    ? `${p.name} — ${openProj.has(p.id) ? "Click to hide worktrees" : "Click to show worktrees"}`
                    : undefined
                }
                onClick={() => toggleProj(p.id)}
              >
                <span className="tree-row__chevron tree-row__project-chevron" aria-hidden>
                  {openProj.has(p.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span className="tree-row__label">
                  {collapsed ? disambiguatedAbbrev(p.name, p.id, visibleProjects) : p.name}
                </span>
              </button>
              <button
                type="button"
                className="icon-btn tree-row__action"
                aria-label={`New session in ${p.name}`}
                title={collapsed ? `New session — ${p.name}` : undefined}
                onClick={() => setNewSessProject(p)}
              >
                <Plus size={16} />
              </button>
              {!collapsed ? (
                <button
                  type="button"
                  data-proj-menu-trigger
                  className="icon-btn tree-row__action"
                  aria-label={`Project actions for ${p.name}`}
                  aria-expanded={projMenu?.project.id === p.id}
                  aria-haspopup="menu"
                  title="Project menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setProjMenu((prev) =>
                      prev?.project.id === p.id ? null : { project: p, rect },
                    );
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
              ) : null}
            </div>
            {openProj.has(p.id)
              ? (() => {
                  const wtList = (worktreeMap[p.id] ?? []).filter((w) => {
                    if (!hideInactiveWorktrees) return true;
                    const ss = sessionMap[w.id] ?? [];
                    return !worktreeIsInactive(ss, sessionStates);
                  });
                  return wtList.map((w) => (
                    <div key={w.id} className="wt-row-wrap">
                      <div
                        className="tree-row tree-row--worktree"
                        data-active={activeWorktreeId === w.id && location.pathname.startsWith("/worktree/")}
                        style={{ position: "relative" }}
                        title={collapsed ? `${w.branch} — select worktree` : undefined}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void selectWorktree(p.id, w);
                          }
                        }}
                      >
                        <Link
                          to={`/worktree/${w.id}`}
                          className="wt-row__stretch-link"
                          aria-label={`Open worktree ${w.branch}`}
                          onClick={(e) => {
                            if (isModifiedClick(e)) return;
                            selectWorktree(p.id, w);
                          }}
                          tabIndex={-1}
                        />
                        <div className="wt-row__expand">
                          {!collapsed ? (
                            <span className="wt-leading-slot" aria-hidden>
                              <StatusDot
                                status={worktreeRolledUpStatus(sessionMap[w.id] ?? [], sessionStates)}
                              />
                            </span>
                          ) : null}
                          <span className="wt-row__label">
                            {collapsed ? disambiguatedAbbrev(w.branch, w.id, wtList.map((x) => ({ id: x.id, name: x.branch }))) : w.branch}
                          </span>
                        </div>
                        {!collapsed ? (
                          <div className="wt-row__trail" style={{ position: "relative", zIndex: 2 }}>
                            <span className="wt-row__id" title={w.id}>
                              {w.id}
                            </span>
                            <button
                              type="button"
                              data-wt-menu-trigger
                              className="icon-btn wt-menu-trigger tree-row__action"
                              aria-label={`Worktree actions for ${w.branch}`}
                              aria-expanded={wtMenu?.worktree.id === w.id}
                              aria-haspopup="menu"
                              title="Worktree menu"
                              onClick={(e) => {
                                e.stopPropagation();
                                const rect = e.currentTarget.getBoundingClientRect();
                                setWtMenu((prev) =>
                                  prev?.worktree.id === w.id
                                    ? null
                                    : { projectId: p.id, worktree: w, rect },
                                );
                              }}
                            >
                              <MoreHorizontal size={16} />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ));
                })()
              : null}
          </div>
        ))}
      </div>
      <div className="left-sidebar__footer">
        <Link
          to="/settings"
          className={`left-sidebar__nav-item${isSettings ? " left-sidebar__nav-item--active" : ""}`}
          title="Settings"
          aria-label="Settings"
          aria-current={isSettings ? "page" : undefined}
          onClick={() => {
            if (isMobile) setMobileSidebarOpen(false);
          }}
        >
          <SlidersHorizontal size={16} aria-hidden />
          {!collapsed ? <span>Settings</span> : null}
        </Link>
        <div className="left-sidebar__icon-row">
          <button
            type="button"
            className="icon-btn"
            aria-label="Toggle font"
            title="Font"
            onClick={toggleFont}
          >
            <Type size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Toggle theme"
            title={`Theme (${theme})`}
            onClick={toggleTheme}
          >
            <Moon size={16} />
          </button>
        </div>
      </div>

      {newSessProject ? (
        <NewSessionDialog
          open
          projectId={newSessProject.id}
          projectName={newSessProject.name}
          api={api}
          onClose={() => setNewSessProject(null)}
          onCreated={() => { /* store stays current via session:created WS event */ }}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete worktree?"
        message={
          pendingDelete
            ? `Remove “${pendingDelete.branch}” from this workspace? Sessions attached to this worktree will be removed from the UI.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={() => void confirmDeleteWorktree()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={pendingDismiss !== null}
        title="Dismiss worktree?"
        message={
          pendingDismiss
            ? `Remove “${pendingDismiss.branch}” from vst tracking? Files and git branch stay on disk. Any running sessions will be stopped.`
            : ""
        }
        confirmLabel="Dismiss"
        onConfirm={() => void confirmDismissWorktree()}
        onCancel={() => setPendingDismiss(null)}
      />

      {wtMenu
        ? createPortal(
            <div
              className="menu-pop wt-menu-pop--portal"
              data-wt-menu-panel
              role="menu"
              aria-label="Worktree actions"
              style={{
                position: "fixed",
                top: wtMenu.rect.bottom + 6,
                left: Math.max(
                  8,
                  Math.min(
                    wtMenu.rect.right - 176,
                    typeof window !== "undefined" ? window.innerWidth - 184 : 8,
                  ),
                ),
                minWidth: 140,
                zIndex: 4000,
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item menu-pop__item--icon"
                onClick={(e) => {
                  e.stopPropagation();
                  const wtId = wtMenu.worktree.id;
                  const wasPinned = wtMenu.worktree.pinnedAt != null;
                  setWtMenu(null);
                  void (async () => {
                    try {
                      if (wasPinned) await api.unpinWorktree(wtId);
                      else await api.pinWorktree(wtId);
                      // Store stays current via the `worktree:updated` WS event.
                    } catch {
                      /* surface errors later */
                    }
                  })();
                }}
              >
                <Pin
                  size={13}
                  aria-hidden
                  fill={wtMenu.worktree.pinnedAt != null ? "currentColor" : "none"}
                />
                {wtMenu.worktree.pinnedAt != null ? "Unpin" : "Pin to top"}
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item"
                onClick={(e) => {
                  e.stopPropagation();
                  void (async () => {
                    try {
                      await api.markWorktreeDone(wtMenu.worktree.id);
                      // Store stays current via per-session `session:state`
                      // events emitted by the daemon when marking done.
                    } catch {
                      /* surface errors later */
                    }
                    setWtMenu(null);
                  })();
                }}
              >
                Mark as done
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDismiss(wtMenu.worktree);
                  setWtMenu(null);
                }}
              >
                Dismiss (keep files)
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item--danger"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDelete(wtMenu.worktree);
                  setWtMenu(null);
                }}
              >
                Delete worktree…
              </button>
            </div>,
            document.body,
          )
        : null}
      {projMenu
        ? createPortal(
            <div
              className="menu-pop wt-menu-pop--portal"
              data-proj-menu-panel
              role="menu"
              aria-label="Project actions"
              style={{
                position: "fixed",
                top: projMenu.rect.bottom + 6,
                left: Math.max(
                  8,
                  Math.min(
                    projMenu.rect.right - 176,
                    typeof window !== "undefined" ? window.innerWidth - 184 : 8,
                  ),
                ),
                minWidth: 160,
                zIndex: 4000,
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item menu-pop__item--icon"
                onClick={(e) => {
                  e.stopPropagation();
                  setNewSessProject(projMenu.project);
                  setProjMenu(null);
                }}
              >
                <Plus size={13} aria-hidden />
                New worktree
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item menu-pop__item--icon"
                onClick={(e) => {
                  e.stopPropagation();
                  const projectId = projMenu.project.id;
                  setProjMenu(null);
                  void (async () => {
                    try {
                      await api.hideProject(projectId);
                      // Store stays current via the `project:updated` WS event;
                      // the active-project redirect is handled in Workspace.
                    } catch {
                      /* surface errors later */
                    }
                  })();
                }}
              >
                <EyeOff size={13} aria-hidden />
                Hide project
              </button>
            </div>,
            document.body,
          )
        : null}
      {filterMenuRect
        ? createPortal(
            <div
              className="menu-pop wt-menu-pop--portal"
              data-filter-menu-panel
              role="menu"
              aria-label="Filter options"
              style={{
                position: "fixed",
                top: filterMenuRect.bottom + 6,
                left: Math.max(
                  8,
                  Math.min(
                    filterMenuRect.right - 140,
                    typeof window !== "undefined" ? window.innerWidth - 148 : 8,
                  ),
                ),
                minWidth: 140,
                zIndex: 4000,
              }}
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={hideInactiveWorktrees}
                className={`menu-pop__item menu-pop__item--check${hideInactiveWorktrees ? " menu-pop__item--active" : ""}`}
                onClick={() => { toggleInactiveWorktreesFilter(); setFilterMenuRect(null); }}
              >
                <span className="menu-pop__check" aria-hidden>
                  {hideInactiveWorktrees ? <Check size={13} strokeWidth={2.5} /> : null}
                </span>
                Hide done
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
