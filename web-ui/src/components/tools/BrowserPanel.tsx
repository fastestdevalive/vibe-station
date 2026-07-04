import { ArrowLeft, ArrowRight, Globe, RotateCw } from "lucide-react";
import { ToolPlaceholder } from "./ToolPlaceholder";

/**
 * Placeholder for the in-app browser. Real implementation will embed a webview
 * the agent can drive (load a URL, refresh, navigate). The toolbar below shows
 * the intended controls (disabled until wired).
 */
export function BrowserPanel() {
  return (
    <ToolPlaceholder
      icon={<Globe size={28} />}
      title="Browser"
      description="Run the website here — load a URL, refresh, and navigate. The agent will be able to drive this view to show the app it's building."
      toolbar={
        <div className="browser-bar" aria-hidden>
          <button type="button" className="browser-bar__btn" disabled aria-label="Back">
            <ArrowLeft size={15} />
          </button>
          <button type="button" className="browser-bar__btn" disabled aria-label="Forward">
            <ArrowRight size={15} />
          </button>
          <button type="button" className="browser-bar__btn" disabled aria-label="Reload">
            <RotateCw size={14} />
          </button>
          <input
            className="browser-bar__url"
            type="text"
            placeholder="https://localhost:3000"
            disabled
          />
        </div>
      }
    />
  );
}
