import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { usePaneOutletElement } from "./paneOutlets";

/**
 * agent:<sessionId> | terminal:<sessionId> | tools:<worktreeId>
 *
 * Identifies a permanently-mounted live pane. See PaneOutletRegistry
 * (paneOutlets.tsx) for how a pane's rendered output finds its way to
 * wherever it should currently be displayed.
 */
export type PaneKey = `agent:${string}` | `terminal:${string}` | `tools:${string}`;

interface PaneHostLayerProps {
  /** Every pane that should be mounted right now. */
  paneKeys: PaneKey[];
  /** Supplies the actual <AgentPaneSlot>/<TerminalPane>/<ToolPanel> element for a key. */
  renderPane: (key: PaneKey) => ReactNode;
}

/**
 * Keeps every live pane (agent chat, terminal, tools) PERMANENTLY mounted at
 * a single, stable position in the React tree — this component's own render
 * — for the pane's entire session lifetime. Per the repo's hard invariant
 * (see AGENTS.md): unmounting a live pane sends `session:close` to the
 * daemon and kills the underlying PTY/stream, so panes must never be
 * removed from the tree just because a layout transition (classic <->
 * workspace tiling, tab switches, etc.) changes where they're displayed.
 *
 * Each pane's rendered output is portaled (via `createPortal`, which moves
 * only the DOM node, not the React tree position) into whichever
 * `<PaneOutlet>` currently claims that pane's key. If no outlet currently
 * claims it, the pane renders into an offscreen hidden holder instead of
 * unmounting — so it keeps running, just invisible.
 *
 * `PaneHostLayer` itself is layout-mode-agnostic: it doesn't know or care
 * whether classic or workspace-tiled layout is active. Callers (e.g.
 * Layout.tsx) mount it unconditionally as a sibling and simply feed it
 * whichever `paneKeys` should be alive right now.
 */
export function PaneHostLayer({ paneKeys, renderPane }: PaneHostLayerProps) {
  return (
    <>
      {paneKeys.map((key) => (
        <PaneHostSlot key={key} paneKey={key}>
          {renderPane(key)}
        </PaneHostSlot>
      ))}
    </>
  );
}

function PaneHostSlot({ paneKey, children }: { paneKey: PaneKey; children: ReactNode }) {
  const outlet = usePaneOutletElement(paneKey);

  // This div's position as a child of PaneHostLayer never changes shape
  // based on paneKey content — only whether `outlet` is null flips between
  // the offscreen class and portaling. React never remounts `children`
  // (the actual pane) because of this; only the portal target changes.
  return (
    <div className={outlet ? undefined : "pane-holder--offscreen"}>
      {outlet ? createPortal(children, outlet) : children}
    </div>
  );
}
