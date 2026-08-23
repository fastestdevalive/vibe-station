import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * PaneOutletRegistry — a live directory of `<PaneOutlet>` DOM nodes keyed by
 * paneKey. `PaneHostLayer` (see PaneHostLayer.tsx) reads this registry via
 * `usePaneOutletElement` to decide where to portal each permanently-mounted
 * pane's rendered output. The Map itself lives in a ref (not React state) so
 * registration/unregistration never triggers a re-render on its own; each
 * key has its own tiny subscriber list so only components actually watching
 * that key re-render when its outlet element changes.
 */

type Listener = () => void;

/**
 * A registration token. Each `<PaneOutlet>`/`<ToolbarOutlet>` instance owns one
 * for its whole lifetime, so `unregister` can remove *that instance's* entry
 * rather than blowing away whatever happens to be stored under the key.
 *
 * Without this, two components legitimately mounting the same paneKey at once
 * (e.g. a stale classic-mode fullscreen overlay lingering next to the canvas
 * tile that owns the same `tools:<worktreeId>` pane) collide: the second
 * registration silently overwrites the first, and whichever unmounts first
 * deletes the key outright — leaving the surviving outlet a permanently empty
 * "ghost" window.
 */
export type OutletToken = { readonly id: number };

interface Registration {
  token: OutletToken;
  el: HTMLElement;
}

interface RegistryValue {
  createToken: () => OutletToken;
  register: (key: string, token: OutletToken, el: HTMLElement | null) => void;
  unregister: (key: string, token: OutletToken) => void;
  getOutlet: (key: string) => HTMLElement | null;
  subscribe: (key: string, listener: Listener) => () => void;
}

const PaneOutletRegistryContext = createContext<RegistryValue | null>(null);

export function PaneOutletProvider({ children }: { children: ReactNode }) {
  const outletsRef = useRef<Map<string, Registration[]>>(new Map());
  const listenersRef = useRef<Map<string, Set<Listener>>>(new Map());
  const nextTokenId = useRef(0);

  const notify = useCallback((key: string) => {
    const listeners = listenersRef.current.get(key);
    if (!listeners) return;
    for (const listener of listeners) listener();
  }, []);

  const createToken = useCallback(() => ({ id: nextTokenId.current++ }), []);

  const register = useCallback(
    (key: string, token: OutletToken, el: HTMLElement | null) => {
      const list = outletsRef.current.get(key) ?? [];
      const next = list.filter((r) => r.token !== token);
      if (el) next.push({ token, el });
      if (next.length > 0) outletsRef.current.set(key, next);
      else outletsRef.current.delete(key);
      notify(key);
    },
    [notify],
  );

  const unregister = useCallback(
    (key: string, token: OutletToken) => {
      const list = outletsRef.current.get(key);
      if (!list) return;
      const next = list.filter((r) => r.token !== token);
      if (next.length === list.length) return;
      // Only clear the key once no live instance still claims it.
      if (next.length > 0) outletsRef.current.set(key, next);
      else outletsRef.current.delete(key);
      notify(key);
    },
    [notify],
  );

  // Most recently registered live entry wins.
  const getOutlet = useCallback((key: string) => {
    const list = outletsRef.current.get(key);
    if (!list || list.length === 0) return null;
    return list[list.length - 1]?.el ?? null;
  }, []);

  const subscribe = useCallback((key: string, listener: Listener) => {
    let listeners = listenersRef.current.get(key);
    if (!listeners) {
      listeners = new Set();
      listenersRef.current.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) listenersRef.current.delete(key);
    };
  }, []);

  const value = useMemo<RegistryValue>(
    () => ({ createToken, register, unregister, getOutlet, subscribe }),
    [createToken, register, unregister, getOutlet, subscribe],
  );

  return (
    <PaneOutletRegistryContext.Provider value={value}>
      {children}
    </PaneOutletRegistryContext.Provider>
  );
}

function useRegistry(): RegistryValue {
  const ctx = useContext(PaneOutletRegistryContext);
  if (!ctx) {
    throw new Error("PaneOutlet components must be used within a PaneOutletProvider");
  }
  return ctx;
}

/**
 * Renders the DOM node other components portal into for `paneKey`. Mount
 * exactly one of these wherever a pane should currently be visible (e.g.
 * inside a workspace tile); unmount it (e.g. tile closes/layout changes) and
 * `usePaneOutletElement` reports null for that key again — the pane itself
 * stays mounted elsewhere (see PaneHostLayer), it just loses its visible home.
 */
export function PaneOutlet({ paneKey }: { paneKey: string }) {
  const { createToken, register, unregister } = useRegistry();
  const tokenRef = useRef<OutletToken | null>(null);
  if (tokenRef.current === null) tokenRef.current = createToken();
  const token = tokenRef.current;

  const refCallback = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) register(paneKey, token, el);
      else unregister(paneKey, token);
    },
    [paneKey, token, register, unregister],
  );

  // MUST be a flex column container, not a plain block. Every pane root that
  // gets portaled in here (`.agent-pane-slot`, `.terminal-pane-root`,
  // `.tool-panel`) sizes itself with `flex: 1; min-height: 0` — the shape it
  // needs inside classic layout's `.pane-stack`. In a *block* parent `flex: 1`
  // is inert, so the pane falls back to `height: auto` and sizes to its
  // intrinsic content instead of to the outlet: a fresh xterm (no rows yet)
  // collapses to ~0px, and a warmed-up one overflows past the tile. Making the
  // outlet a flex container reproduces `.pane-stack`'s height propagation, so
  // panes fill the outlet exactly and stay responsive when the tile resizes.
  return (
    <div
      ref={refCallback}
      style={{
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    />
  );
}

/** paneKey `WorkspaceCanvas.tsx` portals its toolbar (mode toggle, saved-doc
 *  name, Save as workspace, Add tile) into, via `ToolbarOutlet` below —
 *  mounted by `TopBar.tsx` for the detached `/workspaces/:id` page ONLY,
 *  which has room top-right and no per-worktree pane toggles competing for
 *  it. The classic per-worktree canvas does not portal: it keeps that
 *  toolbar as its own dedicated row above the canvas body. */
export const WORKSPACE_CANVAS_TOOLBAR_KEY = "workspace-canvas-toolbar";

/**
 * Same registry as `PaneOutlet`, but for small inline chrome (e.g. the
 * workspace canvas's mode/save/add-tile toolbar on the detached
 * `/workspaces/:id` page, portaled up into `TopBar` — see
 * `WorkspaceCanvas.tsx`'s `usePaneOutletElement(WORKSPACE_CANVAS_TOOLBAR_KEY)`
 * call) rather than a
 * pane that needs to fill its container. Row-flex, sized to content, not
 * stretched to 100%/100% like `PaneOutlet`.
 */
export function ToolbarOutlet({ paneKey }: { paneKey: string }) {
  const { createToken, register, unregister } = useRegistry();
  const tokenRef = useRef<OutletToken | null>(null);
  if (tokenRef.current === null) tokenRef.current = createToken();
  const token = tokenRef.current;

  const refCallback = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) register(paneKey, token, el);
      else unregister(paneKey, token);
    },
    [paneKey, token, register, unregister],
  );

  return (
    <div
      ref={refCallback}
      style={{ display: "flex", alignItems: "center", minWidth: 0 }}
    />
  );
}

/** Returns the current outlet DOM node for `paneKey`, or null if none is mounted. */
export function usePaneOutletElement(paneKey: string): HTMLElement | null {
  const { getOutlet, subscribe } = useRegistry();
  const [, forceRender] = useState(0);

  useEffect(() => {
    // The outlet may have registered/unregistered between the render that
    // read `getOutlet` and this effect running — re-check once on mount/key
    // change, then stay in sync via the subscription for subsequent changes.
    forceRender((v) => v + 1);
    return subscribe(paneKey, () => forceRender((v) => v + 1));
  }, [paneKey, subscribe]);

  return getOutlet(paneKey);
}
