import { forwardRef, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Check, Clock, Copy, MessageSquare, X } from "lucide-react";
import { RESTORED_COPY, TERMINAL_LIMIT_BYTES, type TrayState } from "./trayState";
import { RICH_SEND_MAX_BYTES, RICH_SEND_MAX_COMMENTS } from "./reviewLimits";
import { plural } from "@/lib/plural";
import { COPY_OFFLINE_TITLE, OFFLINE_TRAY_TEXT } from "./reviewCopy";

const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1024));

export interface TrayStripProps {
  tray: TrayState;
  expanded: boolean;
  compact: boolean;
  /** Ticked "Needs you" rows: what Copy / Schedule / Send act on. */
  selectedCount: number;
  agentName: (sessionId: string) => string;
  composerNames: (keys: string[]) => string;
  busy: boolean;
  error: string | null;
  listId: string;
  onToggleExpanded: () => void;
  onSend: () => void;
  onSchedule: () => void;
  onCopy: () => void;
  copied: boolean;
  onDetach: () => void;
  onCancelDelivery: (id: string) => void;
  onRetry: () => void;
  onDismissDelivery: () => void;
  onPickAnother: () => void;
  onDismissRestored: () => void;
}

/** The count (and chevron) that expands the list; the strip's left edge in every state that has comments. */
function CountButton({ label, expanded, listId, onClick }: { label: ReactNode; expanded: boolean; listId: string; onClick: () => void }) {
  return (
    <button type="button" className="comment-tray__count" aria-expanded={expanded} aria-controls={listId} onClick={onClick}>
      <MessageSquare size={14} className="comment-tray__icon" aria-hidden />
      <span>{label}</span>
      {expanded ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
    </button>
  );
}

function CopyButton({ props, disabledNote }: { props: TrayStripProps; disabledNote?: string }) {
  const offline = props.tray.offline;
  return (
    <button
      type="button"
      className="comment-icon-btn"
      aria-label="Copy as text"
      title={offline ? COPY_OFFLINE_TITLE : (disabledNote ?? "Copy as text")}
      disabled={offline || props.selectedCount === 0}
      onClick={props.onCopy}
    >
      {props.copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      {props.copied ? <span className="comment-sr">Copied</span> : null}
    </button>
  );
}

/** The strip's right edge in the normal state: Copy, Schedule, Send to agent… (mobile: just Send…). */
function SendControls({ props, label }: { props: TrayStripProps; label: string }) {
  const { tray, selectedCount, compact } = props;
  const disabled = !tray.canSend || selectedCount === 0;
  const offlineTitle = tray.offline ? OFFLINE_TRAY_TEXT : undefined;
  return (
    <>
      {compact ? null : <CopyButton props={props} />}
      {compact ? null : (
        <button type="button" className="comment-btn" disabled={disabled} title={offlineTitle} onClick={props.onSchedule}>
          <Clock size={13} aria-hidden />
          Schedule
        </button>
      )}
      <button
        type="button"
        className="comment-btn comment-btn--primary comment-tray__send"
        disabled={disabled}
        title={offlineTitle}
        onClick={props.onSend}
      >
        {label}
      </button>
    </>
  );
}

function FileChips({ tray }: { tray: TrayState }) {
  const shown = tray.files.slice(0, 3);
  const more = tray.files.length - shown.length;
  return (
    <div className="comment-tray__files">
      {shown.map((f) => (
        <span key={f.path} className="comment-tray__fchip" title={f.path}>
          <span className="comment-tray__fname">{f.path.split("/").pop()}</span> <b>{f.count}</b>
        </span>
      ))}
      {more > 0 ? <span className="comment-tray__fchip comment-tray__fchip--more">{`+${more} more`}</span> : null}
    </div>
  );
}

/**
 * The tray strip in each state of the `Send` board B: normal, attached, sending (waiting / pasting), restored,
 * timed out, agent exited, over the limit, offline. Pure: the container owns the data and the actions.
 */
export const TrayStrip = forwardRef<HTMLDivElement, TrayStripProps>(function TrayStrip(props, ref) {
  const { tray, expanded, compact, selectedCount, listId } = props;
  const p = tray.primary;
  const n = tray.count;
  const sendLabel = compact ? "Send…" : expanded ? `Send ${selectedCount} to agent…` : "Send to agent…";
  let left: ReactNode;
  let right: ReactNode;
  let tone = "";

  if (p.kind === "sending") {
    const agent = props.agentName(p.delivery.sessionId);
    const behind = p.delivery.waitsBehind ?? 0;
    left = (
      <span className="comment-tray__status">
        <span className="comment-tray__dot" aria-hidden />
        <b>{`Sending ${p.delivery.commentCount} to ${agent} · ${p.phase === "waiting" ? "waiting until ready" : "pasting…"}`}</b>
        {p.phase === "waiting" && behind > 0 ? (
          <span className="comment-tray__meta">{`· waits behind ${plural(behind, "scheduled message", "scheduled messages")}`}</span>
        ) : null}
      </span>
    );
    if (tray.unsentCount > 0) {
      left = (
        <>
          {left}
          <CountButton label={<b>{`· ${tray.unsentCount} new`}</b>} expanded={expanded} listId={listId} onClick={props.onToggleExpanded} />
        </>
      );
    }
    right = (
      <>
        {p.canCancel ? (
          <button type="button" className="comment-btn" disabled={props.busy} onClick={() => props.onCancelDelivery(p.delivery.id)}>
            Cancel · restore
          </button>
        ) : null}
        {tray.unsentCount > 0 ? <SendControls props={props} label={sendLabel} /> : null}
      </>
    );
  } else if (p.kind === "timed_out") {
    tone = "warn";
    left = <b className="comment-tray__warn">{`Timed out · ${props.agentName(p.delivery.sessionId)} still busy · comments restored`}</b>;
    right = (
      <>
        <button type="button" className="comment-btn" disabled={props.busy || tray.offline} onClick={props.onRetry}>
          Retry
        </button>
        <CopyButton props={{ ...props, selectedCount: Math.max(selectedCount, 1) }} />
        <DismissButton onClick={props.onDismissDelivery} />
      </>
    );
  } else if (p.kind === "agent_exited") {
    tone = "danger";
    left = (
      <>
        <b className="comment-tray__danger">Agent exited, not delivered</b>
        <span className="comment-tray__meta">comments restored</span>
      </>
    );
    right = (
      <>
        <button type="button" className="comment-btn" onClick={props.onPickAnother}>
          Pick another
        </button>
        <DismissButton onClick={props.onDismissDelivery} />
      </>
    );
  } else if (p.kind === "restored") {
    tone = "warn";
    const reasons = [...new Set(p.groups.map((g) => RESTORED_COPY[g.reason]))].join(", ");
    left = (
      <>
        <CountButton
          label={<b className="comment-tray__warn">{`${plural(p.count, "comment", "comments")} restored`}</b>}
          expanded={expanded}
          listId={listId}
          onClick={props.onToggleExpanded}
        />
        <span className="comment-tray__meta">{`· ${reasons}`}</span>
      </>
    );
    right = (
      <>
        <button type="button" className="comment-btn" disabled={props.busy || tray.offline} onClick={props.onDismissRestored}>
          Dismiss
        </button>
        <SendControls props={props} label={sendLabel} />
      </>
    );
  } else if (p.kind === "over_limit") {
    left = (
      <>
        <CountButton label={<b>{`${plural(p.count, "comment", "comments")} · ${kb(p.bytes)} KB`}</b>} expanded={expanded} listId={listId} onClick={props.onToggleExpanded} />
        <span className="comment-tray__meta">
          {`over the limit (${RICH_SEND_MAX_COMMENTS} / ${kb(RICH_SEND_MAX_BYTES)} KB; Terminal ${kb(TERMINAL_LIMIT_BYTES)} KB)`}
        </span>
      </>
    );
    right = (
      <>
        <CopyButton props={{ ...props, selectedCount: Math.max(selectedCount, 1) }} />
        <button type="button" className="comment-btn comment-btn--primary comment-tray__send" disabled>
          Send
        </button>
      </>
    );
  } else if (tray.offline) {
    left = (
      <>
        <CountButton label={<b>{OFFLINE_TRAY_TEXT}</b>} expanded={expanded} listId={listId} onClick={props.onToggleExpanded} />
        <span className="comment-tray__meta">Send disabled</span>
      </>
    );
    right = <SendControls props={props} label={sendLabel} />;
  } else if (p.kind === "attached") {
    left = (
      <>
        <CountButton
          label={<b>{`${p.count} attached to ${props.composerNames(p.composerKeys)}`}</b>}
          expanded={expanded}
          listId={listId}
          onClick={props.onToggleExpanded}
        />
        {tray.unsentCount > 0 ? <span className="comment-tray__meta">{`· ${tray.unsentCount} new`}</span> : null}
      </>
    );
    right = (
      <>
        <button type="button" className="comment-btn" disabled={props.busy || tray.offline} onClick={props.onDetach}>
          Detach
        </button>
        {tray.unsentCount > 0 ? <SendControls props={props} label={sendLabel} /> : null}
      </>
    );
  } else {
    left = (
      <>
        <CountButton label={<b>{plural(n, "comment", "comments")}</b>} expanded={expanded} listId={listId} onClick={props.onToggleExpanded} />
        {compact ? <span className="comment-tray__meta">{plural(tray.files.length, "file", "files")}</span> : expanded ? <span className="comment-tray__grow" /> : <FileChips tray={tray} />}
      </>
    );
    right = <SendControls props={props} label={sendLabel} />;
  }

  return (
    <div ref={ref} className={`comment-tray__strip${tone ? ` comment-tray__strip--${tone}` : ""}${compact ? " comment-tray__strip--compact" : ""}`} data-state={p.kind}>
      {left}
      <span className="comment-tray__spacer" />
      {right}
      {props.error ? (
        <span className="comment-tray__error" role="alert">
          {props.error}
        </span>
      ) : null}
    </div>
  );
});

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="comment-icon-btn" aria-label="Dismiss" title="Dismiss" onClick={onClick}>
      <X size={13} aria-hidden />
    </button>
  );
}
