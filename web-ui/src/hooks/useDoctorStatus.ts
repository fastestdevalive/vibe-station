import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { DoctorReport } from "@/api/types";

export type DoctorFetchState = "loading" | "ready" | "unreachable";

export interface DoctorStatusState {
  fetchState: DoctorFetchState;
  report: DoctorReport | null;
  lastCheckedAt: number | null;
  checking: boolean;
  recheck: () => void;
}

/**
 * Polls GET /api/doctor on mount, on daemon reconnect, and every 5 minutes
 * while the tab is visible. Single-flight: concurrent rechecks are no-ops.
 * Stale responses (an older request resolving after a newer one) are dropped
 * via a monotonic request-id guard.
 */
export function useDoctorStatus(
  api: ApiInstance,
  options?: { enabled?: boolean },
): DoctorStatusState {
  const enabled = options?.enabled ?? true;
  const [fetchState, setFetchState] = useState<DoctorFetchState>("loading");
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);
  const requestId = useRef(0);
  // Set when an automatic trigger (reconnect/visibility/interval) lands while
  // a run is in flight — single-flight would otherwise drop it, e.g. an
  // "online" recheck swallowed by a still-pending "offline" one, leaving the
  // badge stuck on unreachable. A user Re-check click never queues.
  const rerunQueued = useRef(false);
  const subscribed = useRef(false);

  const runCheck = useCallback((queueIfBusy: boolean) => {
    if (inFlight.current) {
      if (queueIfBusy) rerunQueued.current = true;
      return;
    }
    inFlight.current = true;
    setChecking(true);
    const myId = ++requestId.current;
    api
      .getDoctorReport()
      .then((res) => {
        if (myId !== requestId.current) return;
        setReport(res);
        setFetchState("ready");
        setLastCheckedAt(Date.now());
      })
      .catch(() => {
        if (myId !== requestId.current) return;
        setFetchState("unreachable");
      })
      .finally(() => {
        inFlight.current = false;
        setChecking(false);
        if (rerunQueued.current) {
          rerunQueued.current = false;
          if (subscribed.current) runCheck(false);
        }
      });
  }, [api]);

  const recheck = useCallback(() => runCheck(false), [runCheck]);

  useEffect(() => {
    if (!enabled) return;
    subscribed.current = true;
    runCheck(true);
    const offConn = api.subscribeConnection((s) => {
      // "offline"/"disconnected" also re-check so a dropped daemon flips the
      // badge to unreachable instead of showing the last report for up to 5 min.
      if (s !== "connecting") runCheck(true);
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") runCheck(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") runCheck(true);
    }, 5 * 60 * 1000);
    return () => {
      subscribed.current = false;
      rerunQueued.current = false;
      offConn();
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, [api, runCheck, enabled]);

  return { fetchState, report, lastCheckedAt, checking, recheck };
}
