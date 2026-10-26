import { useCallback } from "react";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import { usePaneDialogs, type ResetRunOptions } from "./usePaneDialogs";
import { useResetProgress } from "./useResetProgress";

export type { ResetRunOptions } from "./usePaneDialogs";

type ResetApi = Pick<ApiInstance, "resetSession">;

// Module-level so every PaneDialogHost (one per mounted agent pane) can't fire
// two resets for the same session; a second request would run its own handoff
// turn and then fail with "already archived".
const inFlightResets = new Set<string>();

/** Demo hard-reset (see `lib/demoRuntime.ts`). */
export function __resetForDemo(): void {
  inFlightResets.clear();
}

/** The daemon's `{ "error": "…" }` text when the body is JSON, else the raw message. */
export function resetErrorText(err: unknown): string {
  if (!(err instanceof Error)) return "Failed to start a fresh session.";
  try {
    const body = JSON.parse(err.message) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    /* not JSON */
  }
  return err.message;
}

function needsReplacementMode(err: unknown): boolean {
  return err instanceof ApiError && (err.code === "mode_not_found" || err.code === "no_mode");
}

/** Errors that keep the current agent alive and offer the fallback notice (OQ2). */
function isFallbackError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === "reset_cancelled" || err.code === "handoff_failed" || err.code === "busy_timeout")
  );
}

/** User-facing fallback copy — never says "reset" or "handoff" (decision I). */
function fallbackNoticeText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "reset_cancelled") return "Cancelled. The current agent is still running.";
    if (err.code === "busy_timeout") {
      return "The agent didn't stop in time. Nothing changed — the current agent is still running.";
    }
    if (err.code === "handoff_failed") {
      return "The summary wasn't written. Nothing changed — the current agent is still running.";
    }
  }
  return resetErrorText(err);
}

/**
 * Shared start-fresh / switch flow. Every pane-scoped dialog host owns one
 * instance; the module-level in-flight set dedupes across panes.
 *
 * `run(sessionId, opts)` sends the new `carryOver` / `whenBusy` / `queued` body.
 * The mode-retry prompt and the fallback notice are written into
 * `usePaneDialogs` (not local `useState`) so they survive a host unmount.
 */
export function useSessionReset(
  api: ResetApi,
  onDone?: () => void,
): {
  run: (sessionId: string, opts?: ResetRunOptions) => void;
} {
  const run = useCallback(
    (sessionId: string, opts: ResetRunOptions = {}) => {
      if (inFlightResets.has(sessionId)) return;
      inFlightResets.add(sessionId);

      const dialogs = usePaneDialogs.getState();
      // Starting a reset from this pane's dialog closes it.
      dialogs.close(sessionId);
      dialogs.clearModePrompt(sessionId);
      dialogs.clearNotice(sessionId);

      // Wire precedence: explicit carryOver wins; legacy `handoff`/`handoffText`
      // mean Summary; otherwise Nothing.
      const carryOver = opts.carryOver ?? (opts.handoff || opts.handoffText !== undefined ? "summary" : "none");
      const whenBusy = opts.whenBusy ?? "stop";
      // Decision 9: the cancellable bar shows for a summary wait and for any
      // explicit "wait for the current turn".
      if (carryOver === "summary") useResetProgress.getState().start(sessionId, "summary");
      else if (whenBusy === "wait") useResetProgress.getState().start(sessionId, "waiting");

      const body = {
        carryOver,
        ...(opts.modeId ? { modeId: opts.modeId } : {}),
        ...(opts.channel ? { channel: opts.channel } : {}),
        ...(whenBusy !== "stop" ? { whenBusy } : {}),
        ...(opts.queued ? { queued: opts.queued } : {}),
        ...(opts.handoffText !== undefined ? { handoffText: opts.handoffText } : {}),
      };

      void api
        .resetSession(sessionId, body)
        .then(() => onDone?.())
        .catch((err: unknown) => {
          if (needsReplacementMode(err)) {
            usePaneDialogs.getState().setModePrompt({
              sessionId,
              reason: resetErrorText(err),
              options: { ...opts, carryOver },
            });
            return;
          }
          if (isFallbackError(err)) {
            usePaneDialogs.getState().setNotice({
              sessionId,
              text: fallbackNoticeText(err),
              options: { ...opts, carryOver },
            });
            return;
          }
          window.alert(resetErrorText(err));
          onDone?.();
        })
        .finally(() => {
          // On success, error, or a cancelled/failed summary, release the lock
          // and finish the in-progress bar so it always clears.
          inFlightResets.delete(sessionId);
          useResetProgress.getState().finish(sessionId);
        });
    },
    [api, onDone],
  );

  return { run };
}
