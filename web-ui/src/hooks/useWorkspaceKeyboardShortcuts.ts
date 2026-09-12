import { useEffect } from "react";
import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * ⌘/Ctrl+Shift+F → Files tool tab; ⌘/Ctrl+Shift+Z → terminal dock;
 * ⌘/Ctrl+P quick-open files; ⌘/Ctrl+\ or ⌘/Ctrl+B → toggle tool pane;
 * ⌘/Ctrl+Shift+G → new agent in current worktree;
 * ⌘/Ctrl+Shift+M → new worktree in the current project;
 * Alt+N → new agent in the current worktree;
 * Alt+Shift+N → new worktree in the current project;
 * ⌘/Ctrl+E → toggle file tree;
 * ⌘/Ctrl+/ → toggle tool split orientation;
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
    const toggleToolPanel = useWorkspaceStore.getState().toggleToolPanel;
    const toggleFileTree = useWorkspaceStore.getState().toggleFileTree;
    const toggleToolSplitOrientation = useWorkspaceStore.getState().toggleToolSplitOrientation;

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inEditable =
        t &&
        (t.tagName === "INPUT" ||
          // Exclude xterm's hidden helper textarea — it is the keyboard target
          // whenever the terminal has focus, but UI shortcuts (Ctrl+B, Ctrl+Shift+Z,
          // etc.) must still fire from the terminal. The xterm customKeyEventHandler
          // in TerminalPane.tsx handles which keys xterm forwards to the PTY vs.
          // lets through; this guard must not re-block them at the app level.
          (t.tagName === "TEXTAREA" && !t.classList.contains("xterm-helper-textarea")) ||
          t.tagName === "SELECT" ||
          t.isContentEditable);

      const mod = e.metaKey || e.ctrlKey;

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

      if (!mod) return;

      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpen((open) => !open);
        return;
      }

      if (inEditable) return;

      // ⌘/Ctrl+E — toggle file tree (VS Code-style). Same placement as Ctrl+P:
      // handled before the `inEditable` guard so it fires even from the terminal
      // (the xterm passthrough in TerminalPane.tsx lets Ctrl+E through to us).
      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        toggleFileTree();
        return;
      }

      // ⌘/Ctrl+\ — toggle tool pane (layout-agnostic: `e.key === "\\"` matches
      // the backslash on US and similar layouts; Ctrl+Shift+\ produces
      // `e.key === "|"` so this never conflicts).
      if (!e.shiftKey && e.key === "\\") {
        e.preventDefault();
        toggleToolPanel();
        return;
      }

      // ⌘/Ctrl+B — toggle tool pane (VS Code-style sidebar shortcut).
      if (!e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleToolPanel();
        return;
      }

      // ⌘/Ctrl+/ — toggle tool split orientation (no args; falls back to the
      // current `toolSplitOrientation` from state). Guarded against the Shift
      // modifier so Ctrl+Shift+/ (i.e. `?` with Ctrl) is not misread here.
      if (!e.shiftKey && !e.altKey && e.key === "/") {
        e.preventDefault();
        toggleToolSplitOrientation();
        return;
      }

      if (e.shiftKey) {
        const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        if (k === "F") {
          e.preventDefault();
          setToolPanelTab("files");
        } else if (k === "Z") {
          e.preventDefault();
          if (!canvasMode) toggleTerminalDock();
        } else if (e.code === "KeyG") {
          // ⌘/Ctrl+Shift+G — new agent in current worktree (replaces the
          // original Ctrl+Shift+A which Chrome on Windows captures for its
          // tab search UI before the page can preventDefault()).
          if (onNewAgent && !canvasMode) {
            e.preventDefault();
            onNewAgent();
          }
        } else if (e.code === "KeyM") {
          // ⌘/Ctrl+Shift+M — new worktree in the current project.
          if (onNewWorktree) {
            e.preventDefault();
            onNewWorktree();
          }
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setQuickOpen, enabled, canvasMode, onNewWorktree, onNewAgent]);
}
