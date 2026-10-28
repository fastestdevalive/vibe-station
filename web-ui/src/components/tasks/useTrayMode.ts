import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { useEventTargets } from "@/context/DemoEnv";
import { ESC_IGNORED_SELECTOR } from "./useTaskEsc";
import { TIMER_MS, init, running, transition, type Effect, type Mode, type TaskClass, type TrayEvent, type TrayState, type View } from "./trayMode";

export interface UseTrayModeOpts {
  sessionId: string;
  /** `undefined` until a real snapshot of this connection arrived. */
  cls: TaskClass | undefined;
  pref: View;
  onWritePref: (v: View) => void;
  /** The full-window task view is open (footer is inert, so pointer/focus holds can't be trusted). */
  viewOpen: boolean;
  rootRef: RefObject<HTMLElement | null>;
  focusComposer?: () => void;
}

export interface TrayRootHandlers {
  onPointerEnter: (e: PointerEvent) => void;
  onPointerLeave: (e: PointerEvent) => void;
  onPointerDown: () => void;
  onFocus: (e: FocusEvent) => void;
  onBlur: (e: FocusEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

export interface UseTrayMode {
  mode: Mode;
  dispatch: (e: TrayEvent) => void;
  rootHandlers: TrayRootHandlers;
  /** React `onScroll` does not bubble, so the list element gets its own. */
  listHandlers: { onScroll: () => void };
}

function isCoarse(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

function focusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Owns the tray's single `setTimeout`, the hold sources (hover, keyboard focus, task view, hidden tab) and
 * focus restoration on mode changes. All view logic lives in the pure `trayMode.ts`.
 */
export function useTrayMode(opts: UseTrayModeOpts): UseTrayMode {
  const { sessionId, cls, pref, viewOpen, rootRef } = opts;
  const { doc } = useEventTargets();
  const ambient = () => ({ viewOpen, docHidden: typeof document !== "undefined" && document.hidden });

  const [store, setStore] = useState<{ sessionId: string; state: TrayState }>(() => ({ sessionId, state: init(cls, pref, ambient()) }));
  const [focusRequest, setFocusRequest] = useState(0);

  // Session switch: adjust state during render (same pattern as `useSessionTasks`).
  let current = store;
  if (store.sessionId !== sessionId) {
    current = { sessionId, state: init(cls, pref, ambient()) };
    setStore(current);
  }
  const state = current.state;

  const stateRef = useRef(state);
  const prefRef = useRef(pref);
  prefRef.current = pref;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusInfo = useRef({ hadFocus: false });
  const dispatchRef = useRef<(e: TrayEvent) => void>(() => undefined);

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const startTimer = useCallback(
    (ms: number) => {
      cancelTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        dispatchRef.current({ type: "timerElapsed" });
      }, ms);
    },
    [cancelTimer],
  );

  const runEffect = useCallback(
    (fx: Effect) => {
      switch (fx.kind) {
        case "startTimer":
          startTimer(fx.ms);
          break;
        case "cancelTimer":
          cancelTimer();
          break;
        case "writePref":
          optsRef.current.onWritePref(fx.view);
          break;
        case "restoreFocus":
          setFocusRequest((n) => n + 1);
          break;
      }
    },
    [startTimer, cancelTimer],
  );

  const dispatch = useCallback(
    (e: TrayEvent) => {
      const root = optsRef.current.rootRef.current;
      const hadFocus = !!root && root.contains(document.activeElement);
      const { state: next, effects } = transition(stateRef.current, e, prefRef.current);
      if (next !== stateRef.current) {
        stateRef.current = next;
        setStore((s) => ({ sessionId: s.sessionId, state: next }));
      }
      for (const fx of effects) {
        if (fx.kind === "restoreFocus") focusInfo.current = { hadFocus };
        runEffect(fx);
      }
    },
    [runEffect],
  );
  dispatchRef.current = dispatch;

  // Commit the render-derived state into the mirror; a session switch also drops the old countdown.
  const lastSession = useRef(sessionId);
  useLayoutEffect(() => {
    stateRef.current = state;
    if (lastSession.current !== sessionId) {
      lastSession.current = sessionId;
      cancelTimer();
    }
  }, [state, sessionId, cancelTimer]);

  // Unmount (and StrictMode's simulated one) clears the timeout; re-arm on remount if still wanted.
  useEffect(() => {
    if (running(stateRef.current) && timerRef.current === null) startTimer(TIMER_MS);
    return cancelTimer;
  }, [startTimer, cancelTimer]);

  // Focus follows a mode change only when the focused node is actually leaving (decision 12).
  useLayoutEffect(() => {
    if (focusRequest === 0 || !focusInfo.current.hadFocus) return;
    const root = rootRef.current;
    const active = document.activeElement;
    const leaving = !active || active === document.body || !root || (root.contains(active) && active.closest("[inert]") !== null);
    if (!leaving) return;
    if (stateRef.current.mode === "hidden" || !root) {
      if (!isCoarse()) optsRef.current.focusComposer?.();
      return;
    }
    root.querySelector<HTMLElement>('[data-tray-toggle][data-active="true"]')?.focus();
  }, [focusRequest, rootRef]);

  // Stuck-hold repair: an unmounted/inert node fires no `focusout`.
  useLayoutEffect(() => {
    const s = stateRef.current;
    if (s.holds.includes("focus") && !rootRef.current?.contains(document.activeElement)) dispatch({ type: "holdOff", reason: "focus" });
  }, [state.mode, rootRef, dispatch]);

  // Task-class changes.
  useEffect(() => {
    if (cls === undefined) dispatch({ type: "tasksUnknown" });
    else dispatch({ type: cls === "none" ? "tasksNone" : cls === "active" ? "tasksActive" : "tasksFinished" });
  }, [cls, dispatch]);

  // Task view round trip (initial value is seeded by `init`).
  const prevView = useRef(viewOpen);
  useEffect(() => {
    if (prevView.current === viewOpen) return;
    prevView.current = viewOpen;
    dispatch({ type: viewOpen ? "holdOn" : "holdOff", reason: "view" });
  }, [viewOpen, dispatch]);

  // Hidden tab.
  useEffect(() => {
    const onVis = () => dispatch({ type: document.hidden ? "holdOn" : "holdOff", reason: "hidden" });
    doc.addEventListener("visibilitychange", onVis);
    return () => doc.removeEventListener("visibilitychange", onVis);
  }, [doc, dispatch]);

  const rootHandlers = useMemo<TrayRootHandlers>(
    () => ({
      onPointerEnter: (e) => {
        if (e.pointerType !== "touch") dispatch({ type: "holdOn", reason: "hover" });
      },
      onPointerLeave: (e) => {
        if (e.pointerType !== "touch") dispatch({ type: "holdOff", reason: "hover" });
      },
      onPointerDown: () => dispatch({ type: "poke" }),
      onFocus: (e) => {
        if (focusVisible(e.target as Element)) dispatch({ type: "holdOn", reason: "focus" });
      },
      onBlur: (e) => {
        const root = rootRef.current;
        if (!root || !(e.relatedTarget instanceof Node) || !root.contains(e.relatedTarget)) dispatch({ type: "holdOff", reason: "focus" });
      },
      onKeyDown: (e) => {
        const m = stateRef.current.mode;
        if (e.key === "Escape" && m === "bar") {
          const t = e.target;
          const ignored = t instanceof Element && t.closest(ESC_IGNORED_SELECTOR) !== null;
          if (e.defaultPrevented || e.nativeEvent.isComposing || ignored || document.querySelector("[role=dialog][aria-modal=true]")) return;
          e.preventDefault();
          e.stopPropagation();
          dispatch({ type: "userCollapse" });
          optsRef.current.focusComposer?.();
          return;
        }
        dispatch({ type: "poke" });
      },
    }),
    [dispatch, rootRef],
  );
  const listHandlers = useMemo(() => ({ onScroll: () => dispatch({ type: "poke" }) }), [dispatch]);

  return { mode: state.mode, dispatch, rootHandlers, listHandlers };
}
