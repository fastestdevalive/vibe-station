import { useEffect, useState, type RefObject } from "react";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import { ScheduleSendPopover } from "@/components/chat/ScheduleSendPopover";
import { scheduleScope, useDraftText } from "@/components/draftsync";
import { apiErrorText } from "@/lib/apiErrorText";
import { SCHEDULE_COPY } from "./scheduleCopy";

/** Shown above the actions; verbatim from board 12 / the plan. */
export const TERMINAL_SCHEDULE_NOTE =
  "At that time the daemon waits until the agent is ready, pastes this as one message and presses Enter. Text already typed at the prompt is submitted too.";

const CODE_FALLBACKS: Record<string, string> = {
  TERMINAL_DELIVERY_UNSUPPORTED: SCHEDULE_COPY.unsupported,
  AGENT_EXITED: SCHEDULE_COPY.agentNotRunning,
  DONE: "Agent is marked done",
  ARCHIVED: "This agent has been archived",
};

interface ScheduleMessagePopoverProps {
  api: ApiInstance;
  sessionId: string;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** Header chip, e.g. "Agent 1 · Terminal". */
  targetLabel: string;
  onClose: () => void;
}

/**
 * "Schedule message" for a Terminal agent: the compose variant of
 * `ScheduleSendPopover` plus the `POST /sessions/:id/schedule` call. Daemon
 * rejections stay in the popover (typed by `ApiError.code`, text from the body).
 */
export function ScheduleMessagePopover({
  api,
  sessionId,
  open,
  anchorRef,
  targetLabel,
  onClose,
}: ScheduleMessagePopoverProps) {
  // The message is server-owned draft text for this agent (F-05): it survives a
  // reload and follows another device. `ScheduleButton` is per session, so the
  // scope change (not a reset effect) is what swaps drafts.
  const draft = useDraftText(api, scheduleScope(sessionId), {
    onRemote: (text) => setMessage(text),
  });
  const [message, setMessage] = useState(() => draft.initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  function onMessageChange(text: string) {
    setMessage(text);
    draft.save(text);
  }

  function submit(fireAt: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    api
      .scheduleMessage(sessionId, message, fireAt)
      .then(() => {
        draft.clear();
        setMessage("");
        onClose();
      })
      .catch((e: unknown) => {
        const fallback = (e instanceof ApiError && e.code && CODE_FALLBACKS[e.code]) || "Couldn't schedule the message.";
        setError(apiErrorText(e, fallback));
      })
      .finally(() => setBusy(false));
  }

  return (
    <ScheduleSendPopover
      open={open}
      anchorRef={anchorRef}
      title="Schedule message"
      messageValue={message}
      onMessageChange={onMessageChange}
      targetLabel={targetLabel}
      note={TERMINAL_SCHEDULE_NOTE}
      error={error}
      busy={busy}
      onSchedule={submit}
      onClose={onClose}
    />
  );
}
