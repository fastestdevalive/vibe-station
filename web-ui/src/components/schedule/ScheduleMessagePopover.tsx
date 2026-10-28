import { useEffect, useState, type RefObject } from "react";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import { ScheduleSendPopover } from "@/components/chat/ScheduleSendPopover";
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
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different agent is a different draft.
  useEffect(() => {
    setMessage("");
    setError(null);
  }, [sessionId]);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  function submit(fireAt: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    api
      .scheduleMessage(sessionId, message, fireAt)
      .then(() => {
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
      onMessageChange={setMessage}
      targetLabel={targetLabel}
      note={TERMINAL_SCHEDULE_NOTE}
      error={error}
      busy={busy}
      onSchedule={submit}
      onClose={onClose}
    />
  );
}
