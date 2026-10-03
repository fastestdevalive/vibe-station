import { useViewportWidth, usePortalRoot, useDemoEnv } from "../../context/DemoEnv";
import { createPortal } from "react-dom";
import { FolderGit, Play } from "lucide-react";
import type { Project } from "@/api/types";
import { clampPopupPosition } from "@/lib/popupPosition";

interface ProjectPlusMenuProps {
  project: Project;
  rect: DOMRect;
  onNewWorktree: () => void;
  onDirectAgent: () => void;
  onClose: () => void;
}

/**
 * Popup menu shown when clicking "+" on a project.
 * For git projects: shows both "New Worktree" and "Direct Agent" options.
 * For non-git projects: shows only "Direct Agent" option.
 */
export function ProjectPlusMenu({
  project,
  rect,
  onNewWorktree,
  onDirectAgent,
  onClose,
}: ProjectPlusMenuProps) {
  const envWidth = useViewportWidth();
  const demoEnv = useDemoEnv();
  const envHeight = demoEnv.viewport?.h ?? (typeof window !== "undefined" ? window.innerHeight : 800);
  const portalRoot = usePortalRoot();
  const popupWidth = 180;
  const popupHeight = project.isGit ? 75 : 45;
  const { top, left } = clampPopupPosition(rect, popupWidth, popupHeight, envWidth, envHeight);

  return createPortal(
    <div
      ref={(node) => {
        if (!node) return;
        const b = node.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) {
          const adj = clampPopupPosition(rect, b.width, b.height, envWidth, envHeight);
          node.style.top = `${adj.top}px`;
          node.style.left = `${adj.left}px`;
        }
      }}
      className="menu-pop project-plus-menu"
      data-project-plus-menu
      role="menu"
      aria-label="New session options"
      style={{
        position: "fixed",
        top,
        left,
        maxHeight: Math.max(80, envHeight - 16),
        overflowY: "auto",
        zIndex: 1000,
      }}
    >
      {project.isGit && (
        <button
          type="button"
          className="menu-pop__item"
          role="menuitem"
          onClick={() => {
            onClose();
            onNewWorktree();
          }}
        >
          <FolderGit size={14} aria-hidden />
          <span>Agent in worktree</span>
        </button>
      )}
      <button
        type="button"
        className="menu-pop__item"
        role="menuitem"
        onClick={() => {
          onClose();
          onDirectAgent();
        }}
      >
        <Play size={14} aria-hidden />
        <span>Agent in project dir</span>
      </button>
    </div>,
    portalRoot,
  );
}
