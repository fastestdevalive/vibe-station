import { useEffect } from "react";
import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * ⌘/Ctrl+Shift+F/P → Files/Preview tool tab; ⌘/Ctrl+Shift+Z → terminal dock;
 * ⌘/Ctrl+P quick-open files.
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
) {
  useEffect(() => {
    if (!enabled) return;

    const setToolPanelTab = useWorkspaceStore.getState().setToolPanelTab;
    const toggleTerminalDock = useWorkspaceStore.getState().toggleTerminalDock;

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const t = e.target as HTMLElement | null;
      const inEditable =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);

      if (!e.shiftKey && e.key.toLowerCase() === "p") {
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
  }, [setQuickOpen, enabled, canvasMode]);
}
