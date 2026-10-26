import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import type { ApiInstance } from "@/api";
import { markRestartReload } from "@/lib/restartMarker";

/** Mirrors `UI_CLI_RESTART_WAIT` in rust/vst-daemon/src/update/timing.rs (a Rust test keeps them equal). */
const RESTART_WAIT_MS = 75_000;
const HEALTH_TIMEOUT_MS = 2_000;

/** `api.health()` raced against a timeout, so a hung request cannot stall polling. */
function healthWithTimeout(api: ApiInstance): ReturnType<ApiInstance["health"]> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("health timeout")), HEALTH_TIMEOUT_MS);
  });
  return Promise.race([api.health(), timeout]).finally(() => clearTimeout(timer));
}

interface RestartOverlayProps {
  api: ApiInstance;
}

export function RestartOverlay({ api }: RestartOverlayProps) {
  const restarting = useUpdateStore((s) => s.restarting);
  const [timedOut, setTimedOut] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const startBootIdRef = useRef<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  // Modal: keep keyboard users out of the app behind the overlay.
  useEffect(() => {
    if (!restarting) return;
    const app = document.getElementById("root");
    app?.setAttribute("inert", "");
    return () => app?.removeAttribute("inert");
  }, [restarting]);

  // Move focus into the dialog, onto Retry once it is waiting for the user.
  useEffect(() => {
    if (!restarting) return;
    (timedOut ? retryRef.current : contentRef.current)?.focus();
  }, [restarting, timedOut]);

  useEffect(() => {
    if (!restarting) {
      setTimedOut(false);
      startBootIdRef.current = null;
      return;
    }

    let active = true;
    let stopped = false;
    let sawDown = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // >= watcher drain wait (15 s) + restore wait (30 s) + restored boot; mirrors UI_CLI_RESTART_WAIT in watch.rs.
    // Its own timer, so a hung health request cannot stop it from firing.
    const deadline = setTimeout(() => {
      stopped = true;
      setTimedOut(true);
    }, RESTART_WAIT_MS);

    // Baseline: the bootId recorded at page load. Only when that is
    // unknown fall back to asking now — the old daemon lingers ~300 ms after
    // accepting the restart, so this usually still sees the old bootId.
    if (!startBootIdRef.current) {
      startBootIdRef.current = useUpdateStore.getState().loadBootId;
    }
    if (!startBootIdRef.current) {
      void healthWithTimeout(api)
        .then((h) => {
          // Never adopt a baseline once the daemon was seen down: a success
          // after that is the successor, handled in `poll`.
          if (active && !sawDown && !startBootIdRef.current) {
            startBootIdRef.current = h.bootId ?? "";
          }
        })
        .catch(() => {
          sawDown = true;
        });
    }

    const poll = async () => {
      if (!active || stopped) return;

      try {
        const h = await healthWithTimeout(api);
        const bootId = h.bootId ?? "";
        const baseline = startBootIdRef.current;
        // With no baseline, "a health failure, then a success" is a new boot.
        const isNewBoot =
          baseline !== null ? Boolean(bootId) && bootId !== baseline : sawDown && Boolean(bootId);
        if (active && isNewBoot) {
          markRestartReload();
          return;
        }
      } catch {
        // Expected while daemon is execing/restarting
        sawDown = true;
      }

      if (active && !stopped) {
        timer = setTimeout(() => {
          void poll();
        }, 500);
      }
    };

    timer = setTimeout(() => {
      void poll();
    }, 500);

    return () => {
      active = false;
      clearTimeout(deadline);
      if (timer) clearTimeout(timer);
    };
  }, [api, restarting, retryCount]);

  if (!restarting) return null;

  const content = (
    <div
      role="alertdialog"
      aria-busy={!timedOut}
      aria-modal="true"
      aria-labelledby="restart-overlay-title"
      className="restart-overlay"
      data-testid="restart-overlay"
    >
      <div className="restart-overlay__backdrop" />
      <div className="restart-overlay__content" ref={contentRef} tabIndex={-1}>
        {!timedOut ? (
          <>
            <div className="restart-overlay__spinner" aria-hidden="true" />
            <h2 id="restart-overlay-title" className="restart-overlay__title">
              Restarting vibe-station…
            </h2>
            <p className="restart-overlay__desc">
              Reconnecting shortly. Terminal (tmux) sessions keep running.
            </p>
          </>
        ) : (
          <>
            <h2 id="restart-overlay-title" className="restart-overlay__title">
              vibe-station didn't come back
            </h2>
            <p className="restart-overlay__desc">
              Run <code className="code-badge">vst open</code> in a terminal.
            </p>
            <div className="restart-overlay__actions">
              <button
                ref={retryRef}
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setTimedOut(false);
                  setRetryCount((c) => c + 1);
                }}
              >
                Retry
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
