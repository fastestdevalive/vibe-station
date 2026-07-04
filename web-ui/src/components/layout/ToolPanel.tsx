import { X } from "lucide-react";
import type { ApiInstance } from "@/api";
import { type ToolTab } from "@/hooks/useStore";
import { useLayout } from "@/hooks/useLayout";
import { FilesPanel } from "@/components/tools/FilesPanel";
import { DevicesPanel } from "@/components/tools/DevicesPanel";
import { ArtifactsPanel } from "@/components/tools/ArtifactsPanel";
import { ToolFullscreenButton } from "@/components/tools/ToolFullscreenButton";

interface ToolPanelProps {
  api: ApiInstance;
  worktreeId: string | null;
  /** Active agent session — drives the file preview. */
  sessionId: string | null;
}

const TABS: { id: ToolTab; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "devices", label: "Devices" },
  { id: "artifacts", label: "Artifacts" },
];

/**
 * Right-side tool panel. Hosts one tool at a time (Files, Devices, Artifacts)
 * selected via the tab strip. Files is master-detail (tree + preview); Devices
 * (web browser + emulators) and Artifacts are placeholders until their backends
 * land.
 */
export function ToolPanel({ api, worktreeId, sessionId }: ToolPanelProps) {
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
            panel (whichever tool is shown), so they live on the selector bar. */}
        <div className="tool-panel__tabs-actions">
          <ToolFullscreenButton />
          <button
            type="button"
            className="tab tab--icon tool-fs-btn"
            aria-label="Close tool panel"
            title="Close tool panel"
            onClick={() => toggleToolPanel()}
          >
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="tool-panel__body">
        {toolPanelTab === "files" ? (
          <FilesPanel api={api} worktreeId={worktreeId} sessionId={sessionId} />
        ) : null}
        {toolPanelTab === "devices" ? <DevicesPanel /> : null}
        {toolPanelTab === "artifacts" ? <ArtifactsPanel /> : null}
      </div>
    </div>
  );
}
