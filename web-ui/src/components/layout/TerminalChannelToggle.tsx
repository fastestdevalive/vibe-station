import { useCallback, useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Mode, Session, SupportedCli } from "@/api/types";
import { ChannelToggleButton } from "@/components/chat/ChannelToggleButton";
import { isSessionModeMissing } from "@/lib/modeIcon";
import { ensureLoaded, retainSubscription, useModesStore } from "@/store/modesStore";

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
 *
 * For sessions whose mode is missing or deleted, the toggle is still shown
 * (as long as modes are loaded and CLIs resolved); clicking it prompts the user
 * to select a valid Rich Chat mode before confirming the channel switch.
 */
export function TerminalChannelToggle({ api, session }: TerminalChannelToggleProps) {
  const modes = useModesStore((s) => s.modes);
  const modesLoaded = useModesStore((s) => s.loaded);

  const [clis, setClis] = useState<SupportedCli[] | null>(null);
  const [clisFailed, setClisFailed] = useState(false);

  const channel = session.channel ?? "tmux";
  const structurallyEligible = session.type === "agent" && channel !== "json";

  useEffect(() => {
    if (!structurallyEligible) return undefined;
    void ensureLoaded(api);
    return retainSubscription(api);
  }, [api, structurallyEligible]);

  useEffect(() => {
    if (!structurallyEligible) return undefined;
    let live = true;
    setClis(null);
    setClisFailed(false);
    api
      .getSupportedClis()
      .then((c) => {
        if (!live) return;
        setClis(c);
      })
      .catch(() => {
        if (!live) return;
        setClisFailed(true);
      });
    return () => {
      live = false;
    };
  }, [api, structurallyEligible]);

  const modeMissing = isSessionModeMissing(session, modes);

  // Stable identity so `ResetModeDialog`'s `displayModes` memo (and the
  // selection effect it drives) only recompute when the CLIs actually change,
  // not on every parent render (review #13). Must be called unconditionally —
  // before the early return below — to keep the hook count stable.
  const filterMode = useCallback(
    (m: Mode) => {
      const cap = clis?.find((c) => c.id === m.cli);
      return cap?.supportsJson ?? true;
    },
    [clis],
  );

  if (!structurallyEligible || !modesLoaded || !clis || clisFailed) return null;

  // If mode exists, check if its CLI supports Rich Chat (hide if false, e.g. agy/pi).
  let importsHistory = true;
  if (!modeMissing) {
    // Inside `!modeMissing`, modeId is guaranteed non-empty and present in the
    // store, so the lookup is total (review #14).
    const resolvedCli = modes.get(session.modeId!)!.cli;
    const cap = clis.find((c) => c.id === resolvedCli);
    if (cap?.supportsJson === false) {
      return null;
    }
    importsHistory = cap?.importsNativeHistory ?? true;
  }

  // No idle gate on this direction (there is no live JSON turn queue to
  // protect) — `triggerDisabled`/`confirmBlocked` stay unset.
  return (
    <ChannelToggleButton
      api={api}
      sessionId={session.id}
      direction="toJson"
      needsMode={modeMissing}
      filterMode={filterMode}
      {...(!modeMissing && !importsHistory
        ? {
            warning:
              "⚠ your terminal turns won't be imported into Rich Chat yet — the agent still remembers them.",
          }
        : {})}
    />
  );
}
