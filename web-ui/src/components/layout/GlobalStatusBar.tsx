import type { Project, Worktree } from "@/api/types";
import { useLayout } from "@/hooks/useLayout";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useVirtualKeyboardVisible } from "@/hooks/useVirtualKeyboardVisible";
import { LspStatusRow } from "@/components/layout/LspStatusRow";

interface GlobalStatusBarProps {
  /** Untyped like `LspStatusRow`'s own `api` — this component only forwards
   *  it to the LSP hooks. */
  api: unknown;
  projects: Project[];
  worktrees: Worktree[];
}

/**
 * Real global bottom status bar, spanning the whole app UI (not scoped to a
 * per-worktree tool panel). Shows the current project / worktree branch name
 * (reusing TopBar's breadcrumb resolution) plus the LSP status indicator for
 * the *currently active* worktree/project, read from `useLayout()` instead of
 * a `ToolPanel`-provided prop — so it stays visible regardless of which tool
 * tab/pane is active and updates when the user switches tabs/worktrees.
 *
 * On mobile it hides itself while the on-screen keyboard is visible (see
 * `useVirtualKeyboardVisible`), so it doesn't overlap the keyboard.
 */
export function GlobalStatusBar({ api, projects, worktrees }: GlobalStatusBarProps) {
  const { activeProjectId, activeWorktreeId } = useLayout();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const keyboardVisible = useVirtualKeyboardVisible();

  const project = projects.find((p) => p.id === activeProjectId);
  const wt = worktrees.find((w) => w.id === activeWorktreeId);

  const hide = isMobile && keyboardVisible;
  if (hide) return null;

  const projectName = project?.name;
  const branch = wt?.branch;

  // The LSP status is scoped to whatever the user is currently viewing: a
  // worktree (scope "worktree", id = active worktree) or a direct/project
  // session (scope "project", id = active project).
  const lspWorktreeId = activeWorktreeId ?? activeProjectId ?? null;
  const scope = activeWorktreeId ? "worktree" : "project";

  return (
    <footer className="global-status-bar">
      {projectName || branch ? (
        <span className="global-status-bar__crumb" title={[projectName, branch].filter(Boolean).join(" › ")}>
          {projectName ? <span className="global-status-bar__crumb-seg">{projectName}</span> : null}
          {projectName && branch ? <span className="global-status-bar__crumb-sep">›</span> : null}
          {branch ? (
            <span className="global-status-bar__crumb-seg global-status-bar__crumb-seg--highlight">{branch}</span>
          ) : null}
        </span>
      ) : (
        <span className="global-status-bar__crumb">
          <span className="global-status-bar__crumb-seg">—</span>
        </span>
      )}
      <div className="global-status-bar__spacer" />
      {activeWorktreeId != null || activeProjectId != null ? (
        <LspStatusRow api={api} worktreeId={lspWorktreeId} scope={scope} />
      ) : null}
    </footer>
  );
}
