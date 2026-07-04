import { useEffect } from "react";
import { useWorkspaceStore } from "@/hooks/useStore";

/** ⌘/Ctrl+Shift+F/P → Files/Preview tool tab; ⌘/Ctrl+Shift+Z → terminal dock; ⌘/Ctrl+P quick-open files */
export function useWorkspaceKeyboardShortcuts(
  setQuickOpen: (v: boolean | ((p: boolean) => boolean)) => void,
  enabled = true,
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
          toggleTerminalDock();
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setQuickOpen, enabled]);
}
