import { useCallback, useState, type ReactNode } from "react";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import type { Session } from "@/api/types";
import { ResetModeDialog } from "@/components/dialogs/ResetModeDialog";
import { useResetProgress } from "./useResetProgress";

type ResetApi = Pick<ApiInstance, "resetSession" | "listModes">;

// Module-level so TabsStrip and WorkspaceCanvas (each with its own hook instance)
// can't fire two resets for the same session; a second request would run its own
// handoff turn and then fail with "already archived".
const inFlightResets = new Set<string>();

/** Demo hard-reset (see `lib/demoRuntime.ts`). */
export function __resetForDemo(): void {
  inFlightResets.clear();
}

/** The daemon's `{ "error": "…" }` text when the body is JSON, else the raw message. */
export function resetErrorText(err: unknown): string {
  if (!(err instanceof Error)) return "Failed to reset session.";
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

interface ModePrompt {
  sessionId: string;
  handoff: boolean;
  reason: string;
}

/**
 * Shared reset flow for every surface that offers Reset / Reset with handoff.
 * Surfaces errors (no toast mechanism exists — see the terminate catch in
 * TabsStrip) and, when the session's mode is gone, asks for a replacement mode
 * and retries instead of dead-ending.
 */
export function useSessionReset(
  api: ResetApi,
  onDone?: () => void,
): { reset: (session: Session, handoff: boolean) => void; modeDialog: ReactNode } {
  const [prompt, setPrompt] = useState<ModePrompt | null>(null);

  const run = useCallback(
    (sessionId: string, handoff: boolean, modeId?: string) => {
      if (inFlightResets.has(sessionId)) {
        // A reset is already running for this session; if the user closed its
        // progress overlay, bring it back instead of silently swallowing the click.
        const progress = useResetProgress.getState();
        if (progress.active[sessionId] === "dismissed") progress.start(sessionId);
        return;
      }
      inFlightResets.add(sessionId);
      // A handoff holds the request open while the old agent writes its summary
      // (10-90s): show progress in that agent's own pane (ResetProgressOverlay).
      if (handoff) useResetProgress.getState().start(sessionId);
      void api
        .resetSession(sessionId, { handoff, ...(modeId ? { modeId } : {}) })
        .then(() => onDone?.())
        .catch((err: unknown) => {
          if (needsReplacementMode(err)) {
            setPrompt({ sessionId, handoff, reason: resetErrorText(err) });
            return;
          }
          window.alert(resetErrorText(err));
          onDone?.();
        })
        .finally(() => {
          inFlightResets.delete(sessionId);
          useResetProgress.getState().finish(sessionId);
        });
    },
    [api, onDone],
  );

  const modeDialog = (
    <ResetModeDialog
      open={prompt !== null}
      api={api}
      reason={prompt?.reason ?? ""}
      onCancel={() => setPrompt(null)}
      onConfirm={(modeId) => {
        const p = prompt;
        setPrompt(null);
        if (p) run(p.sessionId, p.handoff, modeId);
      }}
    />
  );

  return { reset: (session, handoff) => run(session.id, handoff), modeDialog };
}
