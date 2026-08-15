import { X } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import type { ToolTab } from "@/hooks/useStore";
import { useLayout } from "@/hooks/useLayout";
import { FilesPanel } from "@/components/tools/FilesPanel";
import { DevicesPanel } from "@/components/tools/DevicesPanel";
import { ArtifactsPanel } from "@/components/tools/ArtifactsPanel";
import { VcsPanel } from "@/components/tools/VcsPanel";
import { ToolFullscreenButton } from "@/components/tools/ToolFullscreenButton";

interface ToolPanelProps {
  api: ApiInstance;
  /** Context id: a worktree id (scope="worktree") or a project id (scope="project"). */
  worktreeId: string | null;
  /** Browsing scope. "project" is used by direct sessions (files in the base dir). */
  scope?: FileScope;
  /** Worktree's base branch (e.g. "main"), for the VCS tab's upstream-commits group label. */
  baseBranch?: string;
  /**
   * True when this same ToolPanel instance is currently portaled into a
   * workspace-canvas tile (WorkspaceCanvas.tsx) rather than the classic
   * docked tool-panel region. The tile already has its own close (removes
   * the tile) and fullscreen (click title bar) controls in that context —
   * this panel's own fullscreen/close buttons would be redundant at best
   * (two different "fullscreen" behaviors) and actively confusing at worst
   * ("close" here means `toggleToolPanel()`, the classic dock's visibility
   * flag — clicking it from inside a tile just blanks the tile's content
   * with no obvious way back except the top bar's unrelated toggle).
   * ToolPanel is a single shared instance/pane (per the never-unmount
   * invariant) portaled to whichever outlet is currently live, so this has
   * to be a prop threaded from the call site (Workspace.tsx), not something
   * ToolPanel can determine on its own.
   */
  hidePanelControls?: boolean;
}

const TABS: { id: ToolTab; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "devices", label: "Devices" },
  { id: "artifacts", label: "Artifacts" },
  { id: "vcs", label: "VCS" },
];

/**
 * Right-side tool panel. Hosts one tool at a time (Files, Devices, Artifacts)
 * selected via the tab strip. Files is master-detail (tree + preview); Devices
 * (web browser + emulators) and Artifacts are placeholders until their backends
 * land.
 */
export function ToolPanel({
  api,
  worktreeId,
  scope = "worktree",
  baseBranch,
  hidePanelControls = false,
}: ToolPanelProps) {
  const { toolPanelTab, setToolPanelTab, toggleToolPanel } = useLayout();

  return (
    <div className="tool-panel pane-stack">
      <div className="tool-panel__tabs" role="tablist" aria-label="Tools">
        <div className="tool-panel__tabs-scroll">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={toolPanelTab === t.id}
              data-active={toolPanelTab === t.id}
              className="tab"
              onClick={() => setToolPanelTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Panel-level controls — fullscreen + close act on the whole tool
            panel (whichever tool is shown), so they live on the selector bar.
            Hidden inside a workspace-canvas tile — see `hidePanelControls`'s
            doc comment; the tile's own header already owns both concepts. */}
        {!hidePanelControls ? (
          <div className="tool-panel__tabs-actions">
            <ToolFullscreenButton />
            <button
              type="button"
              className="tab tab--icon tool-bar-btn"
              aria-label="Close tool panel"
              title="Close tool panel"
              onClick={() => toggleToolPanel()}
            >
              <X size={13} />
            </button>
          </div>
        ) : null}
      </div>
      <div className="tool-panel__body">
        {worktreeId == null ? (
          // No context (nothing selected yet). Tools are context-scoped, so
          // show a plain empty state — never dashboard/kanban or stale files.
          <div className="empty-state">Select a worktree to use tools</div>
        ) : (
          <>
            {toolPanelTab === "files" ? (
              <FilesPanel api={api} worktreeId={worktreeId} scope={scope} />
            ) : null}
            {toolPanelTab === "devices" ? <DevicesPanel /> : null}
            {toolPanelTab === "artifacts" ? <ArtifactsPanel /> : null}
            {toolPanelTab === "vcs" ? (
              <VcsPanel api={api} worktreeId={worktreeId} baseBranch={baseBranch} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
