import { useEffect } from "react";
import { Columns2, Rows2, X } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import type { ToolTab } from "@/hooks/useStore";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";
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
  /** Worktree's own branch name, rendered as a chip in the VCS tab header. */
  branch?: string;
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
  /** Called when the user clicks the "+" tab or presses Ctrl+P to open the file quick-open dialog. */
  onOpenQuickOpen?: () => void;
  /**
   * Called when the user wants to remove this ToolPanel from the workspace
   * canvas tile it is currently inside. When present alongside
   * `hidePanelControls`, the X close button is rendered — the one action
   * the tile's own header X does NOT cover (the header X removes the whole
   * tile chrome; this X is discoverable from within the tools tab bar
   * itself). Not passed in classic/docked mode — the top bar toggle
   * already hides the panel there, so the X would be redundant.
   */
  onClose?: () => void;
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
  branch,
  hidePanelControls = false,
  onOpenQuickOpen,
  onClose,
}: ToolPanelProps) {
  const { toolPanelTab, setToolPanelTab, activeWorktreeId, activeDirectContextId } = useLayout();

  // Layout-orientation toggle for the Files tab, attached directly to its
  // tab button (live-review feedback, after two earlier homes — the rail,
  // then the Files tab's own tab-strip row — both got rejected as "wrong
  // place"): rendered as a small, independently-focusable icon-button on
  // the right edge of the "Files" tab item (grouped via a wrapping span,
  // not nested inside the tab's own <button> — see the JSX below for why).
  const filesWt = worktreeId ?? "__none__";
  const masterDetailVertical = useWorkspaceStore(
    (s) => !!(s.layoutByWorktree[filesWt] ?? DEFAULT_WORKTREE_LAYOUT).masterDetailVertical,
  );
  const setMasterDetailVertical = useWorkspaceStore((s) => s.setMasterDetailVertical);

  // Decision 9 migration: the "search" tab no longer exists in TABS, but a
  // worktree whose persisted `toolPanelTab === "search"` from before this
  // change must still land somewhere sensible — treat it as "files" at render
  // time, and seed that worktree's Files rail into search mode so the user
  // who had Search open returns there rather than silently resetting to tree.
  const effectiveTab: ToolTab = toolPanelTab === "search" ? "files" : toolPanelTab;

  useEffect(() => {
    // `toolPanelTab` (via useLayout) always reflects the GLOBALLY active
    // worktree/direct-context, not this specific ToolPanel instance's own
    // `worktreeId` prop — on a canvas with multiple tools tiles open
    // simultaneously, every mounted instance sees the same value. Gate the
    // seed on this instance actually BEING that active context, or every
    // mounted tile would seed ITS OWN (possibly unrelated) worktree's rail
    // into search mode off a single flag that only ever described one of
    // them.
    const isActiveContext = worktreeId != null && worktreeId === (activeWorktreeId ?? activeDirectContextId);
    if (toolPanelTab === "search" && isActiveContext) {
      // S-4: ALSO migrate the persisted value to "files", so this migration is
      // truly one-shot. Without it the stale "search" tab value survives and the
      // effect re-runs — re-seeding this worktree's rail into search mode,
      // potentially overriding a user's later choice to be in tree mode — on
      // every worktree switch or additional tools-tile mount.
      setToolPanelTab("files");
      useWorkspaceStore.getState().setFilesLeftPaneMode(worktreeId, "search");
    }
  }, [toolPanelTab, worktreeId, activeWorktreeId, activeDirectContextId, setToolPanelTab]);

  return (
    <div className="tool-panel pane-stack">
      <div className="tool-panel__tabs" role="tablist" aria-label="Tools">
        <div className="tool-panel__tabs-scroll">
          {TABS.map((t) => {
            const showLayoutToggle = t.id === "files" && !!worktreeId;
            const tabButton = (
              <button
                type="button"
                role="tab"
                aria-selected={effectiveTab === t.id}
                data-active={effectiveTab === t.id}
                className="tab"
                onClick={() => setToolPanelTab(t.id)}
              >
                {t.label}
              </button>
            );
            // The layout toggle needs its own real, independently-focusable
            // <button> — HTML forbids nesting interactive controls inside a
            // <button>, and an earlier version that nested a `role="button"`
            // span inside the tab button polluted the tab's accessible name
            // (announced as "Files Switch to stacked layout") and broke the
            // tablist's roving-tabindex convention. A wrapping span keeps
            // both buttons visually grouped as one tab item without nesting.
            if (!showLayoutToggle) return <span key={t.id}>{tabButton}</span>;
            return (
              <span key={t.id} className="tool-panel__files-tab-wrap">
                {tabButton}
                <button
                  type="button"
                  className="tab__layout-toggle"
                  aria-label={masterDetailVertical ? "Switch to side-by-side layout" : "Switch to stacked layout"}
                  title={masterDetailVertical ? "Side-by-side layout" : "Stacked layout"}
                  onClick={() => setMasterDetailVertical(filesWt, !masterDetailVertical)}
                >
                  {masterDetailVertical ? <Columns2 size={13} /> : <Rows2 size={13} />}
                </button>
              </span>
            );
          })}
        </div>
        {/* Panel-level controls — fullscreen + close act on the whole tool
            panel (whichever tool is shown), so they live on the selector bar.
            Hidden inside a workspace-canvas tile — see `hidePanelControls`'s
            doc comment; the tile's own header already owns both concepts.
            When inside a canvas tile, show only the X close button (wired to
            `onClose`, which removes the tools tile) — the tile header's own
            X already removes the whole tile, but an X inside the tab bar
            is more discoverable from within the tools content itself. */}
        {!hidePanelControls ? (
          <div className="tool-panel__tabs-actions">
            <ToolFullscreenButton />
          </div>
        ) : onClose ? (
          <div className="tool-panel__tabs-actions">
            <button
              type="button"
              className="tab tab--icon tool-bar-btn"
              aria-label="Close tool tile"
              title="Close tool tile"
              onClick={onClose}
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
            {effectiveTab === "files" ? (
              <FilesPanel api={api} worktreeId={worktreeId} scope={scope} onOpenQuickOpen={onOpenQuickOpen} />
            ) : null}
            {effectiveTab === "devices" ? <DevicesPanel /> : null}
            {effectiveTab === "artifacts" ? <ArtifactsPanel worktreeId={worktreeId} /> : null}
            {effectiveTab === "vcs" ? (
              <VcsPanel api={api} worktreeId={worktreeId} baseBranch={baseBranch} branch={branch} scope={scope} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
