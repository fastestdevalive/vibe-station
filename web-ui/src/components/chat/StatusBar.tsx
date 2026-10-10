import { useEffect, useState, type ReactNode } from "react";
import type { ApiInstance } from "@/api";
import type { SessionMeta, TurnState } from "@/api/types";
import { ChannelToggleButton } from "./ChannelToggleButton";
import { cliDisplayName } from "@/lib/cliNames";

interface StatusBarProps {
  meta: SessionMeta | null;
  /** Optimistic queued count (pending bubbles) merged with meta.queueDepth. */
  queueDepth?: number;
  /** When provided (with sessionId), enables the channel toggle. */
  api?: ApiInstance;
  sessionId?: string;
  /** Font -/+ controls rendered to the left of the channel toggle overlay. */
  fontControls?: ReactNode;
}

/** Shared with `MessageList`'s `WorkingIndicator` (Decision 8) — one source of
 *  truth for the turn-state label text instead of duplicating this switch.
 *
 *  The busy labels carry NO trailing "…": they render next to the
 *  `WorkingIndicator`'s animated `•••`, so an ellipsis would read as "dots,
 *  then more dots". The non-busy labels ("Ready" / "Queued (n)" / "Error")
 *  never render beside the dots and are unaffected. */
export function turnLabel(state: TurnState | undefined, queue: number): string {
  switch (state) {
    case "thinking":
      return "Thinking";
    case "responding":
      return "Responding";
    case "tool":
      return "Running tool";
    case "queued":
      return `Queued (${queue})`;
    case "error":
      return "Error";
    default:
      return "Ready";
  }
}

/**
 * Footer row: font controls + the Rich Chat → Terminal channel toggle. Token /
 * context-window usage lives in the composer's status row (`ContextMeter`).
 */
export function StatusBar({ meta, queueDepth = 0, api, sessionId, fontControls }: StatusBarProps) {
  const state = meta?.turnState;
  const queue = Math.max(queueDepth, meta?.queueDepth ?? 0);

  // Channel toggle: enabled only when idle — no active, queued, or held-for-edit turn.
  const canToggle = !!(api && sessionId && meta && meta.channel === "json");
  const idle = state === "idle" && queue === 0 && (meta?.editingTurnIds.length ?? 0) === 0;

  const cli = meta?.cli;
  const [importsHistory, setImportsHistory] = useState<boolean | null>(null);
  const [supportsResume, setSupportsResume] = useState<boolean | null>(null);
  useEffect(() => {
    if (!api || !cli) return undefined;
    setImportsHistory(null);
    setSupportsResume(null);
    let live = true;
    void api.getSupportedClis().then((clis) => {
      if (!live) return;
      const entry = clis.find((c) => c.id === cli);
      setImportsHistory(entry?.importsNativeHistory ?? true);
      setSupportsResume(entry?.supportsJsonToTerminalResume ?? true);
    });
    return () => {
      live = false;
    };
  }, [api, cli]);

  return (
    <div className="chat-statusbar" data-turn-state={state ?? "idle"}>
      {/* Spacer: keeps the controls overlay right-aligned (space-between). */}
      <div className="chat-statusbar__info" />
      {canToggle || fontControls ? (
        <div className="chat-font-overlay">
          {fontControls}
          {canToggle ? (
            <ChannelToggleButton
              api={api!}
              sessionId={sessionId!}
              direction="toTerminal"
              triggerDisabled={!idle}
              confirmBlocked={!idle}
              blockedMessage="The session just went busy — wait for it to finish (or clear the queue) before switching."
              {...(() => {
                const warnings = [
                  supportsResume === false
                    ? `⚠ ${cliDisplayName(cli ?? "")} can't resume in the terminal — this switch starts a FRESH terminal conversation instead of continuing this one. Your Rich Chat history stays intact and untouched.`
                    : null,
                  importsHistory === false
                    ? `⚠ ${cliDisplayName(cli ?? "")} can't read its terminal history yet — anything you do in the terminal won't appear back in Rich Chat, though the agent still remembers it.`
                    : null,
                ].filter((w): w is string => w !== null);
                return warnings.length > 0 ? { warning: warnings.join("\n\n") } : {};
              })()}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
