import { useCallback, useEffect, useState } from "react";
import type { ApiInstance } from "@/api";

export interface OobeGateState {
  loading: boolean;
  completed: boolean;
  currentStep: 1 | 2 | 3;
  defaultProjectsDir: string;
  vstHome: string;
  markStep1Confirmed: (dir: string) => void;
  markStep2Confirmed: () => void;
  markCompleted: () => void;
}

interface UseOobeGateOptions {
  enabled: boolean;
}

/**
 * Gate that decides whether the app shows the OOBE onboarding flow instead of
 * the normal workspace. While `enabled` is false (e.g. before auth resolves)
 * the gate is inert: it returns a "completed" state (so the app renders its
 * normal tree), performs no fetch, and subscribes to nothing. When `enabled`
 * flips true it fetches `/api/oobe/state` once and subscribes to the
 * `oobe:state-updated` WS event so a DIFFERENT already-open tab unblocking
 * also unblocks this one (the tab that makes the call applies the HTTP
 * response directly via `markStep1Confirmed`/`markCompleted` — it never waits
 * on its own broadcast).
 *
 * `loading` is deliberately NOT stored in state: a `useState` initializer only
 * runs once at first mount, so seeding it from `opts.enabled` would read stale
 * on the exact render where `enabled` flips false→true. Deriving it inline from
 * the CURRENT `opts.enabled` and `fetched` on every render avoids that
 * one-render-stale flash.
 */
export function useOobeGate(api: ApiInstance, opts: UseOobeGateOptions): OobeGateState {
  const [state, setState] = useState<{
    fetched: boolean;
    completed: boolean;
    currentStep: 1 | 2 | 3;
    defaultProjectsDir: string;
    vstHome: string;
  }>({
    fetched: false,
    completed: true,
    currentStep: 1,
    defaultProjectsDir: "",
    vstHome: "",
  });

  const loading = opts.enabled && !state.fetched;

  useEffect(() => {
    if (!opts.enabled) return;

    let cancelled = false;
    api
      .getOobeState()
      .then((res) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          fetched: true,
          completed: res.completed,
          currentStep: res.currentStep,
          defaultProjectsDir: res.defaultProjectsDir,
          vstHome: res.vstHome,
        }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Fail OPEN: a daemon error, an auth hiccup, or an older daemon
        // without this route must never permanently strand the user on the
        // loading shell with no way forward. Treat it the same as
        // "completed" so the normal app renders — whatever's actually wrong
        // will surface through the app's own error handling instead.
        console.error("useOobeGate: getOobeState() failed, failing open", err);
        setState((prev) => ({ ...prev, fetched: true, completed: true }));
      });

    const off = api.on("oobe:state-updated", (ev) => {
      if (ev.type !== "oobe:state-updated") return;
      if (ev.completed) {
        setState((prev) => ({ ...prev, completed: true }));
      }
    });

    return () => {
      cancelled = true;
      off();
    };
  }, [api, opts.enabled]);

  const markStep1Confirmed = useCallback((dir: string) => {
    setState((prev) => ({ ...prev, currentStep: 2, defaultProjectsDir: dir }));
  }, []);

  const markStep2Confirmed = useCallback(() => {
    setState((prev) => ({ ...prev, currentStep: 3 }));
  }, []);

  const markCompleted = useCallback(() => {
    setState((prev) => ({ ...prev, completed: true }));
  }, []);

  return {
    loading,
    completed: state.completed,
    currentStep: state.currentStep,
    defaultProjectsDir: state.defaultProjectsDir,
    vstHome: state.vstHome,
    markStep1Confirmed,
    markStep2Confirmed,
    markCompleted,
  };
}
