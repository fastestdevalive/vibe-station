import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { LayoutGrid, Pin, Plus } from "lucide-react";
import { usePortalRoot } from "../../context/DemoEnv";
import type { Project, Session, SessionState, Worktree } from "@/api/types";
import { StatusDot } from "@/components/layout/StatusDot";
import { worktreePrStatus } from "@/lib/statusColor";
import { sessionStatus, worktreeRolledUpStatus, type WorktreeRolledUpStatus } from "@/lib/worktreeStatus";
import { sessionLabel, worktreeLabel } from "@/lib/sessionLabel";
import type { WorkspaceDoc } from "@/hooks/useStore";

export type RailPinnedItem =
  | { id: string; kind: "worktree"; data: Worktree }
  | { id: string; kind: "session"; data: Session };

/** Ctrl/cmd/shift/alt or non-primary click opens in a new tab — must not also navigate this one. */
const isModified = (e: React.MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;

interface CollapsedProjectRailProps {
  projects: Project[];
  pinnedItems: RailPinnedItem[];
  workspaces: WorkspaceDoc[];
  worktreeMap: Record<string, Worktree[]>;
  directSessionMap: Record<string, Session[]>;
  sessionMap: Record<string, Session[]>;
  sessionStates: Record<string, SessionState | undefined>;
  activeProjectId: string | null;
  projectById: Record<string, Project | undefined>;
  onSelectProject: (p: Project) => void;
  onSelectWorktree: (p: Project, w: Worktree) => void;
  onNewSession: (p: Project, rect: DOMRect) => void;
}

/** Two-letter monogram for a project tile (initials of the first two words, else first two letters). */
function monogram(name: string): string {
  const words = name.trim().split(/[\s\-_./]+/).filter(Boolean);
  const raw =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "—").slice(0, 2);
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/**
 * Collapsed (icon-rail) replacement for the project tree. Indentation can't
 * work in a ~50px rail, so each project is one tile (monogram + rolled-up
 * status dot); clicking it opens a flyout with that project's direct agents
 * and worktrees, which is where the full-width tree's nesting lives instead.
 */
export function CollapsedProjectRail({
  projects,
  pinnedItems,
  workspaces,
  worktreeMap,
  directSessionMap,
  sessionMap,
  sessionStates,
  activeProjectId,
  projectById,
  onSelectProject,
  onSelectWorktree,
  onNewSession,
}: CollapsedProjectRailProps) {
  const { pathname } = useLocation();
  const portalRoot = usePortalRoot();
  const [open, setOpen] = useState<
    { kind: "project"; projectId: string; rect: DOMRect } | { kind: "pinned" | "workspaces"; rect: DOMRect } | null
  >(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      // The "+" menu is a separate portal opened from inside the flyout —
      // interacting with it must not dismiss the flyout underneath.
      if (flyoutRef.current?.contains(t) || t?.closest?.("[data-rail-tile], [data-project-plus-menu]")) return;
      setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[data-project-plus-menu]")) setOpen(null);
    };
    // The flyout is positioned from a rect captured at click time, so it would drift.
    const onMove = () => setOpen(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    document.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      document.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  // Navigating (from a flyout row or anywhere else) dismisses the flyout.
  useEffect(() => {
    setOpen(null);
  }, [pathname]);

  const openProject =
    open?.kind === "project" ? projects.find((p) => p.id === open.projectId) : undefined;
  const isWtActive = (id: string) => pathname === `/worktree/${id}` || pathname.startsWith(`/worktree/${id}/`);

  function projectStatus(p: Project): WorktreeRolledUpStatus {
    const all: Session[] = [
      ...(directSessionMap[p.id] ?? []),
      ...(worktreeMap[p.id] ?? []).flatMap((w) => sessionMap[w.id] ?? []),
    ];
    return worktreeRolledUpStatus(all, sessionStates as Record<string, SessionState>);
  }

  const direct = openProject ? (directSessionMap[openProject.id] ?? []) : [];
  const wts = openProject ? (worktreeMap[openProject.id] ?? []) : [];

  return (
    <div className="collapsed-rail" role="navigation" aria-label="Projects">
      {pinnedItems.length > 0 ? (
        <button
          type="button"
          data-rail-tile
          className={`collapsed-rail__tile${open?.kind === "pinned" ? " collapsed-rail__tile--open" : ""}`}
          aria-label="Pinned"
          aria-haspopup="menu"
          aria-expanded={open?.kind === "pinned"}
          title="Pinned"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setOpen((prev) => (prev?.kind === "pinned" ? null : { kind: "pinned", rect }));
          }}
        >
          <Pin size={14} aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        data-rail-tile
        className={`collapsed-rail__tile${pathname.startsWith("/workspaces/") ? " collapsed-rail__tile--active" : ""}${open?.kind === "workspaces" ? " collapsed-rail__tile--open" : ""}`}
        aria-label="Workspaces"
        aria-haspopup="menu"
        aria-expanded={open?.kind === "workspaces"}
        title="Workspaces"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setOpen((prev) => (prev?.kind === "workspaces" ? null : { kind: "workspaces", rect }));
        }}
      >
        <LayoutGrid size={14} aria-hidden />
      </button>
      <div className="collapsed-rail__divider" aria-hidden />
      {projects.map((p) => {
        const status = projectStatus(p);
        const isOpen = open?.kind === "project" && open.projectId === p.id;
        return (
          <button
            key={p.id}
            type="button"
            data-rail-tile
            className={`collapsed-rail__tile${p.id === activeProjectId ? " collapsed-rail__tile--active" : ""}${isOpen ? " collapsed-rail__tile--open" : ""}`}
            aria-label={`${p.name} — agents and worktrees`}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            title={p.name}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setOpen((prev) =>
                prev?.kind === "project" && prev.projectId === p.id ? null : { kind: "project", projectId: p.id, rect },
              );
            }}
          >
            <span className="collapsed-rail__mono">{monogram(p.name)}</span>
            {status !== "none" ? (
              <span className="collapsed-rail__status">
                <StatusDot status={status} />
              </span>
            ) : null}
          </button>
        );
      })}
      {open
        ? createPortal(
            <div
              ref={flyoutRef}
              className="menu-pop collapsed-rail__flyout"
              role="menu"
              aria-label={
                open.kind === "project" ? `${openProject?.name ?? "Project"} agents and worktrees` : open.kind === "pinned" ? "Pinned" : "Workspaces"
              }
              style={{
                position: "fixed",
                left: open.rect.right + 14,
                top: Math.max(8, Math.min(open.rect.top, window.innerHeight - 320)),
                maxHeight: window.innerHeight - Math.max(8, Math.min(open.rect.top, window.innerHeight - 320)) - 8,
                zIndex: 900,
              }}
            >
              {open.kind === "project" && openProject ? (
                <>
                  <div className="collapsed-rail__flyout-head">
                    <Link
                      to={`/project/${openProject.id}`}
                      className="collapsed-rail__flyout-title"
                      onClick={() => onSelectProject(openProject)}
                    >
                      {openProject.name}
                    </Link>
                    <button
                      type="button"
                      className="icon-btn collapsed-rail__flyout-add"
                      aria-label={`New session in ${openProject.name}`}
                      title="New session"
                      onClick={(e) => onNewSession(openProject, e.currentTarget.getBoundingClientRect())}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  {direct.length > 0 ? (
                    <>
                      <div className="collapsed-rail__flyout-section">Direct agents</div>
                      {direct.map((s) => (
                        <SessionRow
                          key={s.id}
                          to={`/project/${openProject.id}/${s.id}`}
                          active={pathname === `/project/${openProject.id}/${s.id}`}
                          status={sessionStatus(sessionStates[s.id] ?? s.state)}
                          label={sessionLabel(s)}
                        />
                      ))}
                    </>
                  ) : null}
                  {wts.length > 0 ? (
                    <>
                      <div className="collapsed-rail__flyout-section">Worktrees</div>
                      {wts.map((w) => (
                        <WorktreeRow
                          key={w.id}
                          w={w}
                          active={isWtActive(w.id)}
                          sessions={sessionMap[w.id] ?? []}
                          sessionStates={sessionStates}
                          onClick={(e) => { if (!isModified(e)) onSelectWorktree(openProject, w); }}
                        />
                      ))}
                    </>
                  ) : null}
                  {direct.length === 0 && wts.length === 0 ? (
                    <div className="collapsed-rail__flyout-empty">No agents or worktrees yet</div>
                  ) : null}
                </>
              ) : null}
              {open.kind === "pinned" ? (
                <>
                  <div className="collapsed-rail__flyout-head">
                    <span className="collapsed-rail__flyout-title">Pinned</span>
                  </div>
                  {pinnedItems.map((item) => {
                    if (item.kind === "session") {
                      const s = item.data;
                      return (
                        <SessionRow
                          key={s.id}
                          to={`/project/${s.projectId}/${s.id}`}
                          active={pathname === `/project/${s.projectId}/${s.id}`}
                          status={sessionStatus(sessionStates[s.id] ?? s.state)}
                          label={sessionLabel(s)}
                          hint={s.projectId != null ? projectById[s.projectId]?.name : undefined}
                        />
                      );
                    }
                    const w = item.data;
                    const proj = projectById[w.projectId];
                    return (
                      <WorktreeRow
                        key={w.id}
                        w={w}
                        active={isWtActive(w.id)}
                        sessions={sessionMap[w.id] ?? []}
                        sessionStates={sessionStates}
                        hint={proj?.name}
                        onClick={(e) => { if (proj && !isModified(e)) onSelectWorktree(proj, w); }}
                      />
                    );
                  })}
                </>
              ) : null}
              {open.kind === "workspaces" ? (
                <>
                  <div className="collapsed-rail__flyout-head">
                    <span className="collapsed-rail__flyout-title">Workspaces</span>
                  </div>
                  {workspaces.length === 0 ? (
                    <div className="collapsed-rail__flyout-empty">No workspaces yet</div>
                  ) : (
                    workspaces.map((ws) => (
                      <Link
                        key={ws.id}
                        to={`/workspaces/${ws.id}`}
                        role="menuitem"
                        className={`collapsed-rail__flyout-row${pathname === `/workspaces/${ws.id}` ? " collapsed-rail__flyout-row--active" : ""}`}
                        aria-current={pathname === `/workspaces/${ws.id}` ? "page" : undefined}
                      >
                        <span className="collapsed-rail__flyout-label">{ws.name}</span>
                      </Link>
                    ))
                  )}
                </>
              ) : null}
            </div>,
            portalRoot ?? document.body,
          )
        : null}
    </div>
  );
}

function SessionRow({
  to,
  active,
  status,
  label,
  hint,
}: {
  to: string;
  active: boolean;
  status: WorktreeRolledUpStatus;
  label: string;
  hint?: string;
}) {
  return (
    <Link
      to={to}
      role="menuitem"
      className={`collapsed-rail__flyout-row${active ? " collapsed-rail__flyout-row--active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <StatusDot status={status} pr={null} />
      <span className="collapsed-rail__flyout-label">{label}</span>
      {hint ? <span className="collapsed-rail__flyout-hint">{hint}</span> : null}
    </Link>
  );
}

function WorktreeRow({
  w,
  active,
  sessions,
  sessionStates,
  hint,
  onClick,
}: {
  w: Worktree;
  active: boolean;
  sessions: Session[];
  sessionStates: Record<string, SessionState | undefined>;
  hint?: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <Link
      to={`/worktree/${w.id}`}
      role="menuitem"
      className={`collapsed-rail__flyout-row${active ? " collapsed-rail__flyout-row--active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <StatusDot
        status={worktreeRolledUpStatus(sessions, sessionStates as Record<string, SessionState>)}
        pr={worktreePrStatus(sessions, w.branch)}
      />
      <span className="collapsed-rail__flyout-label">{worktreeLabel(w)}</span>
      {hint ? <span className="collapsed-rail__flyout-hint">{hint}</span> : null}
    </Link>
  );
}
