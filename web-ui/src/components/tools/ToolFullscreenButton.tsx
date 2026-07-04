import { Maximize2, Minimize2 } from "lucide-react";
import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * Fullscreen toggle for the tool panel. Rendered once on the shared
 * Files / Devices / Artifacts selector bar — fullscreen acts on the whole
 * panel (whichever tool is shown), so it's a panel-level control.
 */
export function ToolFullscreenButton() {
  const fullscreen = useWorkspaceStore((s) => s.workspacePaneFullscreen);
  const setFullscreen = useWorkspaceStore((s) => s.setWorkspacePaneFullscreen);
  const active = fullscreen === "tools";
  return (
    <button
      type="button"
      className={`tab tab--icon tool-bar-btn${active ? " tab--fs-active" : ""}`}
      aria-label={active ? "Exit fullscreen" : "Fullscreen"}
      aria-pressed={active}
      title={active ? "Exit fullscreen" : "Fullscreen"}
      onClick={() => setFullscreen(active ? null : "tools")}
    >
      {active ? (
        <Minimize2 size={13} strokeWidth={2} aria-hidden />
      ) : (
        <Maximize2 size={13} strokeWidth={2} aria-hidden />
      )}
    </button>
  );
}
