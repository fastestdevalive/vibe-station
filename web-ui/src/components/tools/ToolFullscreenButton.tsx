import { Maximize2, Minimize2 } from "lucide-react";
import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * Fullscreen toggle for a tool panel. Each tool (Files / Devices / Artifacts)
 * owns its own copy in its top bar, so fullscreen reads as a control of that
 * tool rather than of the tool-selector strip.
 */
export function ToolFullscreenButton() {
  const fullscreen = useWorkspaceStore((s) => s.workspacePaneFullscreen);
  const setFullscreen = useWorkspaceStore((s) => s.setWorkspacePaneFullscreen);
  const active = fullscreen === "tools";
  return (
    <button
      type="button"
      className={`tab tab--icon tool-fs-btn${active ? " tab--fs-active" : ""}`}
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
