import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { useState } from "react";
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
  // `holder` is null for the very first render; the callback ref fires during
  // commit and React batches the state update, so children appear before paint.
  const [holder, setHolder] = useState<HTMLDivElement | null>(null);

  // ALWAYS portal children — never switch between portaled and inline rendering.
  //
  // The old pattern `{outlet ? createPortal(children, outlet) : children}` looks
  // like it preserves the pane, but it doesn't: React reconciles position-0 and
  // sees either a Portal node ($$typeof: REACT_PORTAL_TYPE) or an AgentPaneSlot
  // element ($$typeof: REACT_ELEMENT_TYPE) — different types → unmount + remount
  // on every tab switch. That remounts ChatPane/useChat and wipes in-memory chat
  // history, forcing "load earlier messages" after every tab toggle.
  //
  // By always calling createPortal we only change the *target* DOM node, never
  // the React element type. React moves the portal's DOM without touching the
  // React subtree, so useChat state survives tab switches intact.
  return (
    <>
      {/* Offscreen holder: portal target when no outlet claims this pane.
          Always hidden (display:none via the CSS class) so it never affects layout. */}
      <div className="pane-holder--offscreen" ref={setHolder} />
      {holder && createPortal(children, outlet ?? holder)}
    </>
  );
}
