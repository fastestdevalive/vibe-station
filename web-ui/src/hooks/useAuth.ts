import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import type { AuthCheckResult } from "@/api/client";

export type AuthStatus = "loading" | AuthCheckResult;

export interface AuthState {
  /** Tri-state session status; `unreachable` means the daemon/proxy could not be asked. */
  status: AuthStatus;
  /** Whether the current session is authenticated (`status === "authed"`). */
  authed: boolean;
  /** True while the initial /auth/check call is in flight. */
  loading: boolean;
  /** Call after a successful login to re-enter the app. */
  onLoginSuccess: () => void;
}

/** Backoff while unreachable: 2s, 4s, 8s … capped at 15s; fixed 5s while unauthenticated. */
const delayFor = (s: AuthStatus, attempt: number) =>
  s === "unreachable" ? Math.min(2000 * 2 ** attempt, 15000) : 5000;

/**
 * Checks the current session on mount, keeps re-checking while the user is not
 * authed (so a daemon that was unreachable self-heals and a QR scanned in another
 * app is noticed), and subscribes to auth:expired so mid-session cookie expiry
 * sends the user back to the LoginScreen without a hard page reload.
 */
export function useAuth(): AuthState {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const checkedRef = useRef(false);
  const inFlightRef = useRef(false);

  const recheck = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    let r: AuthCheckResult;
    try {
      r = await api.checkAuthStatus();
    } catch {
      r = "unreachable";
    } finally {
      inFlightRef.current = false;
    }
    // A late result must never knock an already-authed user out (would unmount the workspace).
    setStatus((prev) => (prev === "authed" ? prev : r));
  }, []);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    // In the Tauri desktop shell the token is injected before page JS runs.
    // /auth/check passes for loopback callers — daemon grants access automatically.
    void recheck();
  }, [recheck]);

  // Re-check while not authed: backoff timer + visibility/focus/online/pageshow.
  // `online` does not fire when a VPN comes up, so the timer is the real healer.
  useEffect(() => {
    if (status !== "unreachable" && status !== "unauthenticated") return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const trigger = () => {
      void recheck();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") trigger();
    };
    const tick = async () => {
      await recheck();
      if (cancelled) return;
      timer = setTimeout(tick, delayFor(status, ++attempt));
    };
    timer = setTimeout(tick, delayFor(status, 0));
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", trigger);
    window.addEventListener("online", trigger);
    window.addEventListener("pageshow", trigger); // iOS bfcache restore
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", trigger);
      window.removeEventListener("online", trigger);
      window.removeEventListener("pageshow", trigger);
    };
  }, [status, recheck]);

  // When the WS comes online the daemon is definitely up — retry a failed auth
  // check so a race between Tauri window open and daemon startup self-heals.
  useEffect(() => {
    return api.on("ws:open", () => {
      if (status !== "authed") void recheck();
    });
  }, [status, recheck]);

  // Listen for WS 4401 close — session expired mid-use
  useEffect(() => {
    return api.on("auth:expired", () => {
      setStatus("unauthenticated");
    });
  }, []);

  const onLoginSuccess = useCallback(() => {
    setStatus("authed");
  }, []);

  return { status, authed: status === "authed", loading: status === "loading", onLoginSuccess };
}
