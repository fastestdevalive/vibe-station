import { useCallback, useId, useLayoutEffect, useState, type ReactNode } from "react";
import {
  HOST_PRIORITY,
  useIsReserveHost,
  useTopActionsStore,
  type GroupZone,
} from "@/context/TopActionsContext";
import { useToolsInset, type ListHeaderMode } from "@/context/ToolsInsetContext";

interface ActionsHostProps {
  zone?: GroupZone;
  scope?: string;
  enabled?: boolean;
  priority?: number;
}

/**
 * A slot in a pane's top row. Renders `[pane span][reserve span]`: pane controls portal into the pane span by scope;
 * the reserve span is an empty, token-sized spacer when this host is the one under the actions chip. Renders nothing
 * when disabled or when there is no provider (gallery, bare tests).
 */
export function ActionsHost({ zone, scope, enabled = true, priority = HOST_PRIORITY.default }: ActionsHostProps) {
  const store = useTopActionsStore();
  if (!store || !enabled) return null;
  return <ActionsHostInner zone={zone ?? null} scope={scope ?? null} priority={priority} />;
}

function ActionsHostInner({
  zone,
  scope,
  priority,
}: {
  zone: GroupZone | null;
  scope: string | null;
  priority: number;
}) {
  const store = useTopActionsStore();
  const id = useId();
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);
  const [reserveEl, setReserveEl] = useState<HTMLElement | null>(null);
  const paneRef = useCallback((el: HTMLSpanElement | null) => setPaneEl(el), []);
  const reserveRef = useCallback((el: HTMLSpanElement | null) => setReserveEl(el), []);
  const active = useIsReserveHost(reserveEl);

  // Layout effect: a host that registers after paint would show one frame with the reserve in the wrong row.
  useLayoutEffect(() => {
    if (!store || !paneEl || !reserveEl) return;
    return store.register({ id, zone, scope, priority, paneEl, reserveEl });
  }, [store, id, zone, scope, priority, paneEl, reserveEl]);

  return (
    <div className="actions-host">
      <span ref={paneRef} />
      <span
        ref={reserveRef}
        className="actions-host__reserve"
        data-active={active || undefined}
        data-tauri-drag-region="deep"
      />
    </div>
  );
}

/**
 * Host of a `ToolPanel`: may reserve the chip's width only when this panel owns the window (`hostsGlobal`).
 * `pane`/`reserve` let a host carry only one of the two (the side-by-side list header only reserves).
 */
export function ToolActionsHost({
  when = true,
  pane = true,
  reserve = true,
  priority = HOST_PRIORITY.default,
}: {
  when?: boolean;
  pane?: boolean;
  reserve?: boolean;
  priority?: number;
}) {
  const { hostsGlobal, hostScope } = useToolsInset();
  return (
    <ActionsHost
      zone={reserve && hostsGlobal ? "tools" : undefined}
      scope={pane ? hostScope : undefined}
      enabled={when}
      priority={priority}
    />
  );
}

/**
 * Host of a files-pane mode header. Where the pane controls (layout toggle, Fullscreen) and the chip's reserve
 * land in the active (non-canvas) tools panel, by list state:
 *
 *   list state                       | pane controls   | chip reserve (width under the top-right chip)
 *   ---------------------------------+-----------------+--------------------------------------------
 *   closed (any size)                | Files bar       | Files bar (priority 0)
 *   open, desktop side-by-side       | Files bar       | this mode header (Files bar = fallback, -1)
 *   open, stacked (vertical split)   | this header     | this header (the Files bar has no host)
 *   open, phone side-by-side         | this header     | none (phones have no chip)
 *   a canvas tile / sticky panel     | its own host    | never (`hostsGlobal` is false)
 *
 * Decided by `listHostsPane` / `listHostsGlobal` (computed once in `ToolPanel`, carried by `ToolsInsetContext`);
 * the Files bar side is `FilesPanel`'s `ToolActionsHost` (`when`, `priority`).
 */
export function ModeHeaderActionsHost({ mode }: { mode: ListHeaderMode }) {
  const { listHostsPane, listHostsGlobal, filesMode } = useToolsInset();
  return (
    <ToolActionsHost when={filesMode === mode && (listHostsPane || listHostsGlobal)} pane={listHostsPane} />
  );
}

/**
 * Renders the actions chip's content once, at the top-right of `#workspace-layout` (an absolute box that is never
 * re-parented), and tells the registry which zones' hosts may reserve its width.
 */
export function TopActionsOwner({ zones, children }: { zones: GroupZone[]; children: ReactNode }) {
  const store = useTopActionsStore();
  const key = zones.join(",");
  useLayoutEffect(() => {
    store?.setReserveZones(key ? (key.split(",") as GroupZone[]) : []);
    return () => store?.setReserveZones([]);
  }, [store, key]);
  return (
    <div className="top-actions-anchor">
      {children}
    </div>
  );
}
