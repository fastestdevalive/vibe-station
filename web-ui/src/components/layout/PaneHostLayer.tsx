import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { useClaimedPaneKeys, usePaneOutletElement } from "./paneOutlets";

/**
 * agent:<sessionId> | terminal:<sessionId> | tools:<worktreeId>
 *
 * Identifies a permanently-mounted live pane. See PaneOutletRegistry
 * (paneOutlets.tsx) for how a pane's rendered output finds its way to
 * wherever it should currently be displayed.
 */
export type PaneKey = `agent:${string}` | `terminal:${string}` | `tools:${string}`;

/**
 * Kill switch for lazy pane mounting (item 5b). Set
 * `VITE_EAGER_PANE_MOUNT=1` at build time, or
 * `localStorage["vst:eagerPaneMount"] = "1"` at runtime, to restore the old
 * behavior of mounting every candidate pane up front. Read once at module load
 * so it can't flip mid-session and churn mounts; a reload applies the change.
 *
 * This exists because lazy mounting touches the codebase's hardest-documented
 * invariant (the permanently-mounted pane rule below); the alternative is a
 * single-commit revert.
 */
const EAGER_PANE_MOUNT: boolean = (() => {
  try {
    if (import.meta.env?.VITE_EAGER_PANE_MOUNT === "1") return true;
    return globalThis.localStorage?.getItem("vst:eagerPaneMount") === "1";
  } catch {
    return false;
  }
})();

interface PaneHostLayerProps {
  /**
   * Every pane that is ELIGIBLE to be mounted right now (the active worktree's
   * sessions + tools, or a detached workspace doc's tiles). Panes are mounted
   * lazily out of this candidate set — see `useLazyMountedPaneKeys`.
   */
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
 * Panes are mounted LAZILY out of the candidate `paneKeys`: a pane mounts the
 * first time something makes it visible (a `<PaneOutlet>` claims its key) and
 * then stays mounted, rather than every candidate mounting up front on a
 * worktree switch. This does not weaken the invariant above — mounting is still
 * sticky and still never driven by layout transitions; it only defers the
 * FIRST mount. See `useLazyMountedPaneKeys`, and `EAGER_PANE_MOUNT` for the
 * kill switch.
 *
 * `PaneHostLayer` itself is layout-mode-agnostic: it doesn't know or care
 * whether classic or workspace-tiled layout is active. Callers (e.g.
 * Layout.tsx) mount it unconditionally as a sibling and simply feed it
 * whichever `paneKeys` should be alive right now.
 */
/**
 * Narrows the candidate `paneKeys` down to the ones that should actually be
 * mounted: the union of
 *
 *  (a) every candidate currently claimed by a live `<PaneOutlet>` — i.e. every
 *      pane visible right now (classic mode's active tab, canvas mode's N
 *      tiles, the detached workspace view's tiles), and
 *  (b) every candidate that has been mounted before (sticky).
 *
 * Laziness is additive, never eviction: once a pane is mounted it stays mounted
 * for as long as it remains a candidate, exactly as before — tabbing away and
 * back must not re-fire `session:open`/`chat:open` (and must not tear down the
 * live PTY stream, per the invariant documented on `PaneHostLayer`).
 *
 * The sticky set is pruned to the current candidate set so a worktree switch
 * (which drops the old worktree's keys from `paneKeys`, unmounting its panes as
 * it always has) doesn't resurrect them on a later switch back.
 *
 * Trade-off, stated explicitly so it isn't later filed as a regression: the
 * first-ever visit to a previously-unvisited tab now pays a full attach + tmux
 * replay, where eager mounting had already paid it at worktree-switch time. It
 * is the same cold-open cost, moved from "switch worktree" to "click the tab",
 * in exchange for not firing N+M concurrent opens on every worktree switch.
 */
function useLazyMountedPaneKeys(paneKeys: PaneKey[]): PaneKey[] {
  const claimedKeys = useClaimedPaneKeys();
  const stickyRef = useRef<Set<string>>(new Set());

  const lazyKeys = useMemo(() => {
    const claimed = new Set(claimedKeys);
    const sticky = stickyRef.current;
    const candidates = new Set<string>(paneKeys);
    for (const key of sticky) {
      if (!candidates.has(key)) sticky.delete(key);
    }
    const next = paneKeys.filter((key) => claimed.has(key) || sticky.has(key));
    for (const key of next) sticky.add(key);
    return next;
  }, [paneKeys, claimedKeys]);

  return EAGER_PANE_MOUNT ? paneKeys : lazyKeys;
}

export function PaneHostLayer({ paneKeys, renderPane }: PaneHostLayerProps) {
  const mountedKeys = useLazyMountedPaneKeys(paneKeys);
  return (
    <>
      {mountedKeys.map((key) => (
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
  // the React element type — this avoids the unmount/remount above, where the
  // element type itself changes.
  //
  // It does NOT make a tab switch remount-free on its own, though: React's
  // reconciler still treats a change to the portal's own `containerInfo` (the
  // target DOM node, i.e. `outlet` vs the offscreen `holder`) as a reason to
  // tear down and recreate the portal's children (see react-dom's
  // `updatePortal`), so moving a pane between outlet and holder DOES currently
  // unmount + remount it, same as the pattern above was meant to avoid — this
  // is the pre-existing "Fix C" gap tracked in
  // `.feature-plans/pending/terminal-remount-and-tmux-leak-fixes.md` ("stopping
  // the remount entirely"), not something this component fixes today.
  return (
    <>
      {/* Offscreen holder: portal target when no outlet claims this pane.
          Always hidden (display:none via the CSS class) so it never affects layout. */}
      <div className="pane-holder--offscreen" ref={setHolder} />
      {holder && createPortal(children, outlet ?? holder)}
    </>
  );
}
