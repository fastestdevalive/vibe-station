import { Maximize2, Minimize2, Minus, Plus, X } from "lucide-react";
import { useWorkspaceStore, type WorkspacePaneFullscreen } from "@/hooks/useStore";

interface PaneToolsProps {
  /** Which pane this fullscreen toggle controls ("agent" or "terminal"). */
  fsTarget: WorkspacePaneFullscreen;
  /** Present only on the terminal dock's tools — closes the whole dock. */
  onCloseDock?: () => void;
}

/**
 * Terminal-zoom (`Aa −/+`) + fullscreen toggle, shared between `TabsStrip`
 * (worktree agent/terminal tabs, direct-session terminal dock) and any pane
 * that renders a `TerminalPane` without a surrounding tab list — e.g. a
 * direct session's single agent, which intentionally has no `TabsStrip`
 * ("single agent, no tabs") but still needs these controls above its
 * terminal. Extracted out of `TabsStrip` so the controls aren't lost when
 * the tab list itself is legitimately skipped.
 */
export function PaneTools({ fsTarget, onCloseDock }: PaneToolsProps) {
  const bumpTerminalFont = useWorkspaceStore((s) => s.bumpTerminalFont);
  const workspacePaneFullscreen = useWorkspaceStore((s) => s.workspacePaneFullscreen);
  const setWorkspacePaneFullscreen = useWorkspaceStore((s) => s.setWorkspacePaneFullscreen);
  const fsActive = workspacePaneFullscreen === fsTarget;

  return (
    <div className="tabs-strip__tools">
      <div className="tabs-strip__zoom" aria-label="Terminal zoom">
        <span className="tabs-strip__zoom-label">Aa</span>
        <button
          type="button"
          className="tab tab--icon"
          aria-label="Decrease terminal font"
          onClick={() => bumpTerminalFont(-0.05)}
        >
          <Minus size={11} />
        </button>
        <button
          type="button"
          className="tab tab--icon"
          aria-label="Increase terminal font"
          onClick={() => bumpTerminalFont(0.05)}
        >
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
      {onCloseDock ? (
        <button
          type="button"
          className="tab tab--icon tool-bar-btn"
          aria-label="Close terminal dock"
          title="Close terminal dock"
          onClick={onCloseDock}
        >
          <X size={13} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
