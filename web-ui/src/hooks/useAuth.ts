import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";

export interface AuthState {
  /** Whether the current session is authenticated. */
  authed: boolean;
  /** True while the initial /auth/check call is in flight. */
  loading: boolean;
  /** Call after a successful login to re-enter the app. */
  onLoginSuccess: () => void;
}

/**
 * Checks the current session on mount and subscribes to auth:expired events
 * so mid-session cookie expiry sends the user back to the LoginScreen without
 * a hard page reload.
 */
export function useAuth(): AuthState {
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    void api.checkAuth().then((ok: boolean) => {
      setAuthed(ok);
      setLoading(false);
    });
  }, []);

  // Listen for WS 4401 close — session expired mid-use
  useEffect(() => {
    return api.on("auth:expired" as Parameters<typeof api.on>[0], () => {
      setAuthed(false);
    });
  }, []);

  const onLoginSuccess = useCallback(() => {
    setAuthed(true);
  }, []);

  return { authed, loading, onLoginSuccess };
}
