import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { CliId, Session } from "@/api/types";
import { ChannelToggleButton } from "@/components/chat/ChannelToggleButton";

interface TerminalChannelToggleProps {
  api: ApiInstance;
  /** The tmux/pty agent session rendered in this terminal pane. */
  session: Session;
}

/**
 * Terminal→JSON channel control — mirror of the StatusBar JSON→terminal
 * affordance (`chat/StatusBar.tsx`). Rendered for EVERY **agent** session
 * (worktree-backed or direct/project-scoped) on a tmux/pty channel — the
 * daemon supports the toggle for all agent CLIs in both contexts.
 *
 * Switching tears down the live terminal and reopens the same conversation as
 * JSON chat (resumed via --resume). The terminal-phase turns are backfilled by
 * the P2 importer only for CLIs that ship one (`importsNativeHistory`); for
 * cursor/agy the switch is lossy (those turns won't appear in JSON, though the
 * agent still has them), so we surface a warning before confirming. Unlike
 * json→tty, tty→json has no idle gate (no live JSON turn queue to protect), so
 * the button is always enabled when shown.
 */
export function TerminalChannelToggle({ api, session }: TerminalChannelToggleProps) {
  const [cli, setCli] = useState<CliId | null>(null);
  // null = unknown yet; default to importing (no warning) until resolved.
  const [importsHistory, setImportsHistory] = useState<boolean | null>(null);

  const channel = session.channel ?? "tmux";
  const eligible =
    session.type === "agent" &&
    channel !== "json" &&
    session.modeId != null;

  // Session carries only `modeId`; the history-import capability is per-CLI, so
  // resolve the mode's CLI, then join it against the supported-clis capability
  // list. Skipped entirely when structurally ineligible.
  useEffect(() => {
    if (!eligible) return undefined;
    // Reset immediately, before the fetch resolves — this pane slot isn't
    // keyed by session id, so switching tabs re-renders this component with
    // new props instead of remounting it. Without this reset, a stale `cli`
    // from the PREVIOUS session stays in state during the fetch window.
    setCli(null);
    setImportsHistory(null);
    let live = true;
    void Promise.all([api.listModes(), api.getSupportedClis()]).then(([modes, clis]) => {
      if (!live) return;
      const resolved = modes.find((m) => m.id === session.modeId)?.cli ?? null;
      setCli(resolved);
      const cap = resolved ? clis.find((c) => c.id === resolved) : undefined;
      setImportsHistory(cap?.importsNativeHistory ?? true);
    });
    return () => {
      live = false;
    };
  }, [api, session.modeId, eligible]);

  if (!eligible || !cli) return null;

  // No idle gate on this direction (there is no live JSON turn queue to
  // protect) — `triggerDisabled`/`confirmBlocked` stay unset.
  return (
    <ChannelToggleButton
      api={api}
      sessionId={session.id}
      direction="toJson"
      {...(importsHistory === false
        ? {
            warning:
              "⚠ your terminal turns won't be imported into Rich Chat yet — the agent still remembers them.",
          }
        : {})}
    />
  );
}
