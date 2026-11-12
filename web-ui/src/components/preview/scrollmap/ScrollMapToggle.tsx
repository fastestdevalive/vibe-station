import { Map } from "lucide-react";
import { useFileScrollMap } from "@/hooks/useFileScrollMap";
import type { EffectiveScrollMap } from "./effectiveScrollMapMode";

interface ScrollMapToggleProps {
  display: EffectiveScrollMap | null;
}

export function ScrollMapToggle({ display }: ScrollMapToggleProps) {
  const [value, setFileScrollMap] = useFileScrollMap();

  if (!display || display.display === "none" || display.forced !== null) {
    return null;
  }

  const isMinimap = value === "minimap";

  return (
    <button
      type="button"
      className="scrollmap-toggle-btn"
      aria-pressed={isMinimap}
      aria-label="File minimap"
      title={isMinimap ? "Show change marks instead of the minimap" : "Show the minimap"}
      onClick={() => {
        setFileScrollMap(isMinimap ? "marks" : "minimap");
      }}
    >
      <Map size={14} aria-hidden />
    </button>
  );
}
