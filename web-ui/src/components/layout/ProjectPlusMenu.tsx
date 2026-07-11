import { createPortal } from "react-dom";
import { FolderGit, Play } from "lucide-react";
import type { Project } from "@/api/types";

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
  return createPortal(
    <div
      className="menu-pop project-plus-menu"
      data-project-plus-menu
      role="menu"
      aria-label="New session options"
      style={{
        position: "fixed",
        top: rect.bottom + 6,
        left: Math.max(
          8,
          Math.min(
            rect.right - 180,
            typeof window !== "undefined" ? window.innerWidth - 188 : 8,
          ),
        ),
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
    document.body,
  );
}
