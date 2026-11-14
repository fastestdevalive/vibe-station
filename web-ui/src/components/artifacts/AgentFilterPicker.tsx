import { Check, ChevronDown, Users } from "lucide-react";
import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Session, SessionState } from "@/api/types";
import { SessionModeIcon } from "@/components/agent/SessionModeIcon";
import { StatusDot } from "@/components/layout/StatusDot";
import { sessionLabel } from "@/lib/sessionLabel";
import { sessionStatus } from "@/lib/worktreeStatus";
import { AgentLabel } from "./AgentLabel";
import { ArtifactPopover } from "./ArtifactPopover";
import { artifactCount } from "./artifactSessions";

export interface AgentFilterOption {
  session: Session;
  /** Artifacts written by this agent (or its subagents). */
  count: number;
}

interface AgentFilterPickerProps {
  /** "all" or an agent's session id. */
  value: string;
  options: AgentFilterOption[];
  /** Artifacts in the list (the "All agents" count). */
  total: number;
  sessionStates: Record<string, SessionState>;
  /** ≤768 px: a bottom sheet instead of a popover. */
  mobile: boolean;
  onChange: (value: string) => void;
  /** Quiet line at the top of the menu (e.g. "14 of 200"). */
  meta?: string;
}

const MENU_WIDTH = 260;
const ITEM_H = 30;
const MAX_H = 320;

/** The agent filter: a trigger showing the current agent and a menu of agent rows (mode icon, name, live status, count). */
export function AgentFilterPicker({ value, options, total, sessionStates, mobile, onChange, meta }: AgentFilterPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.session.id === value) ?? null;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const pick = (id: string) => {
    onChange(id);
    close(true);
  };

  // Left-align with the trigger: `clampPopupPosition` aligns right edges, so hand it a rect as wide as the menu.
  const anchorRect = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.left + MENU_WIDTH } : { top: 0, bottom: 0, left: 0, right: MENU_WIDTH };
  };

  const onTriggerKeyDown = (e: ReactKeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const itemClass = `artifacts-menu__item artifacts-agent-option${mobile ? " artifacts-menu__item--touch" : ""}`;
  const item = (id: string, label: string, icon: ReactNode, count: number, state: SessionState | null) => (
    <button
      key={id}
      type="button"
      role="menuitemradio"
      aria-checked={value === id}
      aria-label={[label, state && sessionStatus(state) !== "none" ? sessionStatus(state).replace(/_/g, " ") : null, artifactCount(count)].filter(Boolean).join(", ")}
      className={itemClass}
      onClick={() => pick(id)}
    >
      <span className="artifacts-agent-option__icon">{icon}</span>
      <span className="artifacts-agent-option__name">{label}</span>
      {state ? <StatusDot status={sessionStatus(state)} /> : null}
      <span className="artifacts-agent-option__count">{count}</span>
      <Check size={14} aria-hidden="true" className="artifacts-agent-option__check" />
    </button>
  );

  const currentLabel = selected ? sessionLabel(selected.session) : "All agents";
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="artifacts-agent-picker"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Filter by agent: ${currentLabel}`}
        title="Filter by agent"
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
      >
        {selected ? (
          <AgentLabel session={selected.session} size={11} />
        ) : (
          <span className="artifacts-agent">
            <Users size={13} aria-hidden="true" className="artifacts-agent__all-icon" />
            <span className="artifacts-agent__name">All agents</span>
          </span>
        )}
        {/* "All agents" drops its count: the tools row's "N of 500" already says it. */}
        {selected ? <span className="artifacts-agent-picker__count">{selected.count}</span> : null}
        <ChevronDown size={12} aria-hidden="true" className="artifacts-agent-picker__chevron" />
      </button>
      {open ? (
        <ArtifactPopover
          label="Filter by agent"
          mobile={mobile}
          className="artifacts-agent-menu"
          width={MENU_WIDTH}
          height={Math.min(MAX_H, (options.length + 1) * ITEM_H + 8)}
          maxHeight={MAX_H}
          anchorRect={anchorRect}
          triggerRef={triggerRef}
          watchRef={triggerRef}
          onClose={close}
        >
          {meta ? <div className="artifacts-agent-menu__meta">{meta}</div> : null}
          {item("all", "All agents", <Users size={14} aria-hidden="true" />, total, null)}
          {options.map(({ session, count }) =>
            item(session.id, sessionLabel(session), <SessionModeIcon session={session} size={13} className="artifacts-agent__icon" />, count, sessionStates[session.id] ?? session.state),
          )}
        </ArtifactPopover>
      ) : null}
    </>
  );
}
