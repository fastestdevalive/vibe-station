import { useEffect, useState, type RefObject } from "react";
import type { ApiInstance } from "@/api";
import type { ScheduledPendingMessage } from "@/api/types";
import { ScheduleSendPopover } from "@/components/chat/ScheduleSendPopover";
import { apiErrorText } from "@/lib/apiErrorText";

export interface EditingScheduled {
  id: string;
  row: ScheduledPendingMessage;
}

interface RescheduleHostProps {
  api: ApiInstance;
  sessionId: string;
  /** The row being rescheduled; null closes the popover. */
  editing: EditingScheduled | null;
  /** The strip's Edit button that opened it. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * The "Reschedule" popover for a strip row: `editScheduledMessage` with the
 * daemon's rejection kept inline so the user can pick another time. Mounted by
 * the pane as a sibling of its panes, never around a `TerminalPane`.
 */
export function RescheduleHost({ api, sessionId, editing, anchorRef, onClose }: RescheduleHostProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
  }, [editing?.id]);

  return (
    <ScheduleSendPopover
      open={editing !== null}
      anchorRef={anchorRef}
      initialFireAt={editing?.row.fireAt}
      title="Reschedule"
      error={error}
      busy={busy}
      onSchedule={(fireAt) => {
        if (!editing) return;
        setBusy(true);
        setError(null);
        api
          .editScheduledMessage(sessionId, editing.id, { fireAt })
          .then(() => onClose())
          .catch((e: unknown) => setError(apiErrorText(e, "Couldn't reschedule the message.")))
          .finally(() => setBusy(false));
      }}
      onClose={() => {
        setError(null);
        onClose();
      }}
    />
  );
}
