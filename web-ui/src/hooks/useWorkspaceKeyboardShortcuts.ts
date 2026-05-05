import { useEffect } from "react";
import { useWorkspaceStore } from "@/hooks/useStore";

/** ao-142 parity: ⌘/Ctrl+Shift+F/P/Z toggles file tree / preview / terminal; ⌘/Ctrl+P quick-open files */
export function useWorkspaceKeyboardShortcuts(
  setQuickOpen: (v: boolean | ((p: boolean) => boolean)) => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;

    const togglePane = useWorkspaceStore.getState().togglePaneCollapsed;

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
          togglePane(0);
        } else if (k === "P") {
          e.preventDefault();
          togglePane(1);
        } else if (k === "Z") {
          e.preventDefault();
          togglePane(2);
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setQuickOpen, enabled]);
}
