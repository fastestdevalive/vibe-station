import { useEffect, useRef, useState } from "react";
import { useSupportedClis } from "@/hooks/useSupportedClis";
import { Clock } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { isSessionModeMissing } from "@/lib/modeIcon";
import { sessionLabel } from "@/lib/sessionLabel";
import { ensureLoaded, retainSubscription, useModesStore } from "@/store/modesStore";
import { SCHEDULE_COPY } from "./scheduleCopy";
import { ScheduleMessagePopover } from "./ScheduleMessagePopover";
import type { ScheduleRowData } from "./useScheduledSends";
import "./schedule.css";


interface ScheduleButtonProps {
  api: ApiInstance;
  /** The Terminal agent session rendered in this pane. */
  session: Session;
  /** From the pane's single `useScheduledSends` call (this component holds no hook of its own). */
  rows: ScheduleRowData[];
}

/** Rows that count toward the badge: pending, waiting, pasting. Never failed or sent (`rows` already excludes immediate sends). */
export function scheduledBadgeCount(rows: ScheduleRowData[]): number {
  return rows.filter((r) => r.kind === "pending").length;
}

/**
 * Terminal header "Schedule message" button + its compose popover. Hidden unless
 * the session is a tmux agent whose mode still exists (same gate as
 * `TerminalChannelToggle`); shown disabled with a reason when its CLI can't take
 * a Terminal delivery (`supportsTerminalDelivery`, the daemon's plugin capability).
 */
export function ScheduleButton({ api, session, rows }: ScheduleButtonProps) {
  const modes = useModesStore((s) => s.modes);
  const modesLoaded = useModesStore((s) => s.loaded);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const channel = session.channel ?? "tmux";
  const structurallyEligible = session.type === "agent" && channel === "tmux";

  useEffect(() => {
    if (!structurallyEligible) return undefined;
    void ensureLoaded(api);
    return retainSubscription(api);
  }, [api, structurallyEligible]);

  const { clis } = useSupportedClis(api, structurallyEligible);

  if (!structurallyEligible || !modesLoaded || !clis || isSessionModeMissing(session, modes)) return null;

  const cli = modes.get(session.modeId!)!.cli;
  const supported = clis.find((c) => c.id === cli)?.supportsTerminalDelivery === true;
  const count = scheduledBadgeCount(rows);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`schedule-button${rows.length > 0 ? " schedule-button--on" : ""}`}
        aria-label={count > 0 ? `Schedule message (${count} scheduled)` : "Schedule message"}
        title={supported ? "Schedule message" : SCHEDULE_COPY.unsupported}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!supported}
        onClick={() => setOpen((o) => !o)}
      >
        <Clock size={14} aria-hidden />
        {count > 0 ? <span className="schedule-button__badge">{count}</span> : null}
      </button>
      {supported ? (
        <ScheduleMessagePopover
          api={api}
          sessionId={session.id}
          open={open}
          anchorRef={anchorRef}
          targetLabel={`${sessionLabel(session)} · Terminal`}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
