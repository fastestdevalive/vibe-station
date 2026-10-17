import { useState } from "react";

export type HtmlPreviewMode = "rendered" | "source";

const STORAGE_KEY = "vibestation:html-preview-mode";

/**
 * Persisted Rendered/Source preference for HTML file previews. Reads/writes
 * `localStorage["vibestation:html-preview-mode"]` in try/catch (absent or
 * unreadable ⇒ `"rendered"`).
 */
export function useHtmlPreviewMode(): [HtmlPreviewMode, (m: HtmlPreviewMode) => void] {
  const [mode, setMode] = useState<HtmlPreviewMode>(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return stored === "source" ? "source" : "rendered";
    } catch {
      return "rendered";
    }
  });

  const setHtmlMode = (m: HtmlPreviewMode) => {
    setMode(m);
    try {
      window.localStorage.setItem(STORAGE_KEY, m);
    } catch {
      // localStorage unavailable — in-memory only
    }
  };

  return [mode, setHtmlMode];
}

interface HtmlModeToggleProps {
  mode: HtmlPreviewMode;
  onChange: (m: HtmlPreviewMode) => void;
  renderDisabled?: boolean;
  renderDisabledReason?: string;
}

export function HtmlModeToggle({
  mode,
  onChange,
  renderDisabled = false,
  renderDisabledReason,
}: HtmlModeToggleProps) {
  return (
    <div className="html-mode-toggle" role="group" aria-label="HTML view mode">
      <button
        type="button"
        className="html-mode-toggle__btn"
        aria-pressed={mode === "rendered"}
        disabled={renderDisabled}
        title={renderDisabled ? renderDisabledReason : undefined}
        onClick={() => onChange("rendered")}
      >
        Rendered
      </button>
      <button
        type="button"
        className="html-mode-toggle__btn"
        aria-pressed={mode === "source"}
        onClick={() => onChange("source")}
      >
        Source
      </button>
    </div>
  );
}
