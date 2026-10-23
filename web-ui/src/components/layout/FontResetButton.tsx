import { RotateCcw } from "lucide-react";
import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * "Reset font size" beside the Aa −/+ buttons. `terminalFontScale` is one
 * shared value for the xterm font and Rich Chat's --font-size-* tokens, so
 * resetting from either surface resets both. Disabled at the default 1.0.
 */
export function FontResetButton() {
  const scale = useWorkspaceStore((s) => s.terminalFontScale);
  const reset = useWorkspaceStore((s) => s.resetTerminalFont);
  return (
    <button
      type="button"
      className="terminal-font-overlay__btn"
      aria-label="Reset font size"
      title="Reset font size (terminal and Rich Chat)"
      disabled={scale === 1}
      onClick={reset}
    >
      <RotateCcw size={11} />
    </button>
  );
}
