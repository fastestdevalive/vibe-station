import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * Inline / Side-by-side switch for a diff (tools-pane-rework board 2: it lives in the file strip, not in `DiffView`).
 * Bound to the one store value `DiffView` renders from (`diffLayoutMode`).
 */
export function DiffLayoutSwitch() {
  const mode = useWorkspaceStore((s) => s.diffLayoutMode);
  const setMode = useWorkspaceStore((s) => s.setDiffLayoutMode);
  return (
    <div className="preview-diff-layout-toggle" role="group" aria-label="Diff layout">
      <button
        type="button"
        className={`preview-diff-layout-toggle__btn${mode === "inline" ? " preview-diff-layout-toggle__btn--active" : ""}`}
        aria-pressed={mode === "inline"}
        onClick={() => setMode("inline")}
      >
        Inline
      </button>
      <button
        type="button"
        className={`preview-diff-layout-toggle__btn${mode === "side-by-side" ? " preview-diff-layout-toggle__btn--active" : ""}`}
        aria-pressed={mode === "side-by-side"}
        onClick={() => setMode("side-by-side")}
      >
        Side-by-side
      </button>
    </div>
  );
}
