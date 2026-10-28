import { useEffect, useRef } from "react";
import { FilesLeftRail } from "@/components/layout/FilesLeftRail";
import { handleToolsEsc } from "@/lib/toolsEsc";
import "./ToolsRailColumn.css";

interface ToolsRailColumnProps {
  /** Files context id: worktree id or direct-session project id (Layout's `wt`). */
  contextId: string;
}

/**
 * Desktop window rail (R1, R5, R92): a 35px head cell (a spacer under the actions chip's toggle) + `FilesLeftRail`.
 * A stable trailing SIBLING of the main column in `Layout`, never a wrapper of the
 * agent `PanelGroup`, so mounting/unmounting it can never remount the agent terminal
 * (AGENTS.md "Terminal"). Layout renders it only while the tools pane is shown. The actions chip (rendered once
 * by Layout, absolute top-right) covers the head cell; its toggle is centred on this column.
 */
export function ToolsRailColumn({ contextId }: ToolsRailColumnProps) {
  const rootRef = useRef<HTMLElement>(null);
  const ctxRef = useRef(contextId);
  useEffect(() => {
    ctxRef.current = contextId;
  }, [contextId]);

  // The rail sits outside every ToolPanel root, so a click on a rail icon then Esc
  // would otherwise do nothing. Same shared handler, bubble phase on this root.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => handleToolsEsc(e, ctxRef.current);
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <aside ref={rootRef} className="tools-rail" aria-label="Tools rail column" data-testid="tools-rail-column">
      <div className="tools-rail__head" aria-hidden="true" data-tauri-drag-region="deep" />
      <div className="tools-rail__body">
        <FilesLeftRail worktreeId={contextId} />
      </div>
    </aside>
  );
}
