import { useState } from "react";
import type { ApiInstance } from "@/api";
import type { Channel } from "@/api/types";
import { ApiError } from "@/api/errors";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";

/**
 * The daemon's PATCH …/channel route returns a specific reason as JSON
 * (`{"error": "..."}`) for every 4xx it sends — "not_idle" (409), "<cli> does
 * not support channel toggle" (400), etc. `ApiError.message` carries the raw
 * response TEXT (see `api/client.ts`'s `parseJson`), so extract the real
 * reason instead of always falling back to a generic per-direction string
 * that only actually describes the 409/idle case.
 */
function extractServerReason(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const body = JSON.parse(err.message) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

export type ChannelToggleDirection = "toTerminal" | "toJson";

interface ChannelToggleButtonProps {
  api: ApiInstance;
  sessionId: string;
  direction: ChannelToggleDirection;
  /**
   * Disables the trigger button itself. Only meaningful for `toTerminal`
   * (the JSON→terminal idle gate, item 2) — `toJson` has no gate, pass
   * nothing / `false`.
   */
  triggerDisabled?: boolean;
  /**
   * Re-evaluated live on every render while the confirm dialog is open
   * (Decision 4) — blocks the CONFIRM control even if the trigger was
   * clickable a moment ago. Only meaningful for `toTerminal`.
   */
  confirmBlocked?: boolean;
  /** Shown instead of the default explanation while `confirmBlocked`. */
  blockedMessage?: string;
  /**
   * Extra caveat appended to the confirm dialog's explanation — used to warn
   * that a CLI without a native-history importer switches lossily (its
   * terminal-phase turns won't appear in the JSON view). Omitted when the CLI
   * can import history.
   */
  warning?: string;
}

interface DirectionCopy {
  label: string;
  targetChannel: Channel;
  dialogTitle: string;
  defaultMessage: string;
  confirmVerb: string;
  idleTriggerTitle: string;
  busyTriggerTitle: string;
  errorMessage: string;
}

// UI label is "Rich Chat" (the "(json based)" qualifier appears once, in the
// dialog explanation below) — the CODE/schema continues to use "json" as the
// channel value/identifier throughout. This split is intentional; see
// AGENTS.md "UI terminology — 'Rich Chat' vs the 'json' channel" before
// changing either side to match the other.
const COPY: Record<ChannelToggleDirection, DirectionCopy> = {
  toTerminal: {
    label: "⇄ Terminal",
    targetChannel: "tmux",
    dialogTitle: "Switch to terminal?",
    defaultMessage:
      "This closes Rich Chat and reopens the same conversation in a raw terminal (resumed via --resume). You can switch back to Rich Chat from the terminal — your terminal-phase turns will be backfilled here.",
    confirmVerb: "Switch to terminal",
    idleTriggerTitle: "Switch this session to a raw terminal (keeps the same conversation)",
    busyTriggerTitle: "Finish or clear the queue before switching channel",
    errorMessage: "Couldn't switch — the session is busy. Try again when idle.",
  },
  toJson: {
    label: "⇄ Rich Chat",
    targetChannel: "json",
    dialogTitle: "Switch to Rich Chat?",
    defaultMessage:
      "This ends the live terminal and reopens the same conversation in Rich Chat (json based, resumed via --resume). Your terminal-phase turns will be backfilled into the chat.",
    confirmVerb: "Switch to Rich Chat",
    idleTriggerTitle: "Switch this terminal back to Rich Chat (keeps the same conversation)",
    busyTriggerTitle: "Switch this terminal back to Rich Chat (keeps the same conversation)",
    errorMessage: "Couldn't switch — try again in a moment.",
  },
};

/**
 * Shared channel-toggle affordance (json-mode-followups item 4, Decision 6):
 * the top-right overlay trigger button + `ConfirmDialog` shell used by BOTH
 * toggle directions, so json→terminal (`StatusBar`) and terminal→json
 * (`TerminalChannelToggle`) can never drift apart in placement or behavior
 * again — they already diverged once (that divergence IS item 4).
 *
 * Explicitly NOT the same component as item 3's terminal upload control
 * (Decision 6) — a channel switch and a file attach are unrelated
 * affordances that happen to render in the same pane corner.
 */
export function ChannelToggleButton({
  api,
  sessionId,
  direction,
  triggerDisabled,
  confirmBlocked,
  blockedMessage,
  warning,
}: ChannelToggleButtonProps) {
  const copy = COPY[direction];
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doToggle = async () => {
    setSwitching(true);
    setError(null);
    try {
      await api.setSessionChannel(sessionId, copy.targetChannel);
      setConfirmOpen(false);
    } catch (err) {
      // "not_idle" (409) is the residual race window the live confirmBlocked
      // check (item 2) can't close (network round trip, not a UI gap) — show
      // the friendly per-direction busy copy for that one. Any OTHER reason
      // (e.g. "<cli> does not support channel toggle", a 400) means the
      // generic busy copy would be actively misleading — show the daemon's
      // real reason instead.
      const reason = extractServerReason(err);
      setError(!reason || reason === "not_idle" ? copy.errorMessage : reason);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="channel-toggle-button"
        onClick={() => setConfirmOpen(true)}
        disabled={triggerDisabled}
        title={triggerDisabled ? copy.busyTriggerTitle : copy.idleTriggerTitle}
      >
        {copy.label}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title={copy.dialogTitle}
        message={
          error ??
          [confirmBlocked && blockedMessage ? blockedMessage : copy.defaultMessage, warning]
            .filter(Boolean)
            .join("\n\n")
        }
        confirmLabel={switching ? "Switching…" : copy.confirmVerb}
        confirmDisabled={!!confirmBlocked || switching}
        onConfirm={() => void doToggle()}
        onCancel={() => {
          setConfirmOpen(false);
          setError(null);
        }}
      />
    </>
  );
}
