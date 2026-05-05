import type { ReactNode } from "react";

export type PaneFullscreenPlacement = "panel" | "viewport";

interface PaneFullscreenChromeProps {
  placement: PaneFullscreenPlacement;
  children: ReactNode;
}

/** Flex host for terminal/preview panes (split or fixed viewport overlay). */
export function PaneFullscreenChrome({ placement, children }: PaneFullscreenChromeProps) {
  return (
    <div className={`pane-shell pane-shell--${placement}`}>
      <div className="pane-shell__body">{children}</div>
    </div>
  );
}
