import { useEffect } from "react";
import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * ⌘/Ctrl+Shift+F/P → Files/Preview tool tab; ⌘/Ctrl+Shift+Z → terminal dock;
 * ⌘/Ctrl+P quick-open files; Alt+N → new agent in the current worktree;
 * Alt+Shift+N → new worktree in the current project.
 *
 * The new-agent/new-worktree shortcuts deliberately use bare Alt (no ⌘/Ctrl)
 * combos, not Ctrl+N/Ctrl+Shift+N — those are reserved by the OS/browser
 * chrome (new window, new incognito window) and can't be `preventDefault()`-ed
 * from a page.
 *
 * `canvasMode`: in workspace-canvas mode the terminal dock's visibility flag
 * no longer means anything (every terminal is its own tile, forced-visible —
 * see Workspace.tsx's `<WorkspaceCanvas>` props) and its TopBar button is
 * disabled to match, so ⌘⇧Z is made a no-op there too — a disabled button
 * with a live shortcut behind it would silently flip a flag the UI shows as
 * inert, surprising the user when they later leave canvas mode.
 */
export function useWorkspaceKeyboardShortcuts(
  setQuickOpen: (v: boolean | ((p: boolean) => boolean)) => void,
  enabled = true,
  canvasMode = false,
  onNewWorktree?: () => void,
  onNewAgent?: () => void,
) {
  useEffect(() => {
    if (!enabled) return;

    const setToolPanelTab = useWorkspaceStore.getState().setToolPanelTab;
    const toggleTerminalDock = useWorkspaceStore.getState().toggleTerminalDock;

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inEditable =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);

      // Alt+N / Alt+Shift+N — independent of ⌘/Ctrl, and of the `mod` gate
      // below. `e.code` (physical key), not `e.key`: Option+N is a dead key
      // on the US Mac layout ("Dead"/"˜" instead of "n") — `code` stays
      // layout-independent so this still fires there.
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyN") {
        if (inEditable) return;
        if (e.shiftKey) {
          if (onNewWorktree) {
            e.preventDefault();
            onNewWorktree();
          }
        } else if (onNewAgent && !canvasMode) {
          // In canvas mode every worktree already exposes an equivalent "New
          // agent" entry in the Add-tile picker, which also places the
          // created session as a tile — this global shortcut has no canvas to
          // place into, so defer to that instead of creating an orphaned session.
          e.preventDefault();
          onNewAgent();
        }
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpen((open) => !open);
        return;
      }

      if (inEditable) return;

      if (e.shiftKey) {
        const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        if (k === "F") {
          e.preventDefault();
          setToolPanelTab("files");
        } else if (k === "P") {
          e.preventDefault();
          setToolPanelTab("files");
        } else if (k === "Z") {
          e.preventDefault();
          if (!canvasMode) toggleTerminalDock();
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setQuickOpen, enabled, canvasMode, onNewWorktree, onNewAgent]);
}
