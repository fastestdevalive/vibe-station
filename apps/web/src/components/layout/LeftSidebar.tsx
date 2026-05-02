import { ChevronDown, ChevronRight, FolderTree, Moon, MoreHorizontal, Plus, SlidersHorizontal, Type } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Project, Session, SessionState, Worktree } from "@/api/types";
import type { WSEvent } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useLayout } from "@/hooks/useLayout";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { NewSessionDialog } from "@/components/dialogs/NewSessionDialog";
import { ModesMenuDialog } from "@/components/dialogs/ModesMenuDialog";
import { NewModeDialog } from "@/components/dialogs/NewModeDialog";

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
  if (sessions.length === 0) return true;
  return sessions.every((s) => {
    const st = live[s.id] ?? s.state;
    return st === "done" || st === "exited";
  });
}

interface LeftSidebarProps {
  api: ApiInstance;
  /** Narrow desktop rail: abbreviated labels + compact controls */
  collapsed?: boolean;
  onWorktreeSelected?: () => void;
}

export function LeftSidebar({ api, collapsed = false, onWorktreeSelected }: LeftSidebarProps) {
  const { theme, toggleTheme, toggleFont } = useTheme();
  const [projects, setProjects] = useState<Project[]>([]);
  const [worktreeMap, setWorktreeMap] = useState<Record<string, Worktree[]>>({});
  const [sessionMap, setSessionMap] = useState<Record<string, Session[]>>({});
  const [openProj, setOpenProj] = useState<Set<string>>(() => new Set(["proj-a"]));

  const { activeWorktreeId, setActiveWorktree } = useLayout();
  const clearWorkspaceSelection = useWorkspaceStore((s) => s.clearWorkspaceSelection);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);
  const patchSessionState = useWorkspaceStore((s) => s.patchSessionState);
  const syncSessionsFromApi = useWorkspaceStore((s) => s.syncSessionsFromApi);
  const hideInactiveWorktrees = useWorkspaceStore((s) => s.hideInactiveWorktrees);
  const toggleInactiveWorktreesFilter = useWorkspaceStore((s) => s.toggleInactiveWorktreesFilter);

  const [newSessProject, setNewSessProject] = useState<Project | null>(null);
  const [modesOpen, setModesOpen] = useState(false);
  const [newModeOpen, setNewModeOpen] = useState(false);
  const [wtMenu, setWtMenu] = useState<{ projectId: string; worktree: Worktree; rect: DOMRect } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Worktree | null>(null);
  const refreshProjects = useCallback(async () => {
    const ps = await api.listProjects();
    setProjects(ps);
    const wtM: Record<string, Worktree[]> = {};
    const sM: Record<string, Session[]> = {};
    for (const p of ps) {
      const wts = await api.listWorktrees(p.id);
      wtM[p.id] = wts;
      for (const w of wts) {
        const ss = await api.listSessions(w.id);
        sM[w.id] = ss;
        syncSessionsFromApi(ss);
      }
    }
    setWorktreeMap(wtM);
    setSessionMap(sM);
  }, [api, syncSessionsFromApi]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const sessionIdKey = useMemo(
    () =>
      Object.values(sessionMap)
        .flat()
        .map((s) => s.id)
        .sort()
        .join(","),
    [sessionMap],
  );

  useEffect(() => {
    if (!sessionIdKey) return undefined;
    const ids = sessionIdKey.split(",").filter(Boolean);
    return api.subscribe(ids, (ev: WSEvent) => {
      if (ev.type === "session:state") {
        patchSessionState(ev.sessionId, ev.state);
      }
    });
  }, [api, patchSessionState, sessionIdKey]);

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

  async function confirmDeleteWorktree() {
    if (!pendingDelete) return;
    const worktree = pendingDelete;
    setPendingDelete(null);
    try {
      await api.deleteWorktree(worktree.id);
      if (activeWorktreeId === worktree.id) {
        clearWorkspaceSelection();
      }
      await refreshProjects();
    } catch {
      /* surface errors later */
    }
  }

  function toggleProj(id: string) {
    setOpenProj((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function selectWorktree(projectId: string, w: Worktree) {
    setActiveWorktree(projectId, w.id);
    onWorktreeSelected?.();
  }

  return (
    <div
      className={`left-sidebar ${collapsed ? "left-sidebar--collapsed" : ""}`}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div
        className="left-sidebar__scroll"
        style={{ flex: 1, overflow: "auto", padding: collapsed ? "var(--space-1)" : "var(--space-2)" }}
      >
        <div className="sidebar-projects-heading">
          <span className="sidebar-projects-heading__gutter" aria-hidden />
          {collapsed ? (
            <span className="sidebar-projects-heading__mark" title="Projects">
              <FolderTree size={15} aria-hidden />
            </span>
          ) : (
            <>
              <span className="sidebar-projects-heading__title">Projects</span>
              <label className="sidebar-projects-heading__filter">
                <input type="checkbox" checked={hideInactiveWorktrees} onChange={toggleInactiveWorktreesFilter} />
                hide done
              </label>
            </>
          )}
        </div>
        {projects.length === 0 ? (
          <div className={`empty-state ${collapsed ? "empty-state--collapsed-rail" : ""}`} style={{ padding: collapsed ? "var(--space-2)" : "var(--space-4)" }}>
            {collapsed ? (
              <span title="No projects yet — add one with the CLI">∅</span>
            ) : (
              "No projects yet. Add one with the CLI."
            )}
          </div>
        ) : null}
        {projects.map((p) => (
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
                  {openProj.has(p.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </span>
                <span className="tree-row__label">
                  {collapsed ? disambiguatedAbbrev(p.name, p.id, projects) : p.name}
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
                        data-active={activeWorktreeId === w.id}
                        onClick={() => void selectWorktree(p.id, w)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void selectWorktree(p.id, w);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`Select worktree ${w.name}`}
                        title={collapsed ? `${w.name} — select worktree` : undefined}
                      >
                        <span className="wt-align-gutter" aria-hidden />
                        <span className="wt-row__label">
                          {collapsed ? disambiguatedAbbrev(w.name, w.id, wtList) : w.name}
                        </span>
                        {!collapsed ? (
                          <button
                            type="button"
                            data-wt-menu-trigger
                            className="icon-btn wt-menu-trigger tree-row__action"
                            aria-label={`Worktree actions for ${w.name}`}
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
        <button
          type="button"
          className="icon-btn"
          title="Modes — orchestrator modes and presets"
          aria-label="Modes"
          onClick={() => setModesOpen(true)}
        >
          <SlidersHorizontal size={16} />
        </button>
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

      {newSessProject ? (
        <NewSessionDialog
          open
          projectId={newSessProject.id}
          projectName={newSessProject.name}
          api={api}
          onClose={() => setNewSessProject(null)}
          onCreated={() => void refreshProjects()}
        />
      ) : null}

      <ModesMenuDialog
        open={modesOpen}
        onClose={() => setModesOpen(false)}
        api={api}
        onNewMode={() => {
          setModesOpen(false);
          setNewModeOpen(true);
        }}
      />

      <NewModeDialog
        open={newModeOpen}
        onClose={() => setNewModeOpen(false)}
        api={api}
        onSaved={() => void refreshProjects()}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete worktree?"
        message={
          pendingDelete
            ? `Remove “${pendingDelete.name}” from this workspace? Sessions attached to this worktree will be removed from the UI.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={() => void confirmDeleteWorktree()}
        onCancel={() => setPendingDelete(null)}
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
    </div>
  );
}
