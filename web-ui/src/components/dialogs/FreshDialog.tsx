import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type {
  CarryOver,
  Mode,
  Session,
  SupportedCli,
  WhenBusy,
  QueuedPolicy,
} from "@/api/types";
import { cliDisplayName } from "@/lib/cliNames";
import { ModeIcon } from "@/components/agent/ModeIcon";
import "@/styles/fresh-dialog.css";

export type FreshDialogKind = "fresh" | "switch";

/** Everything the dialog hands back; `run()` turns this into the reset body. */
export interface FreshDialogChoice {
  modeId: string;
  channel: "tmux" | "json";
  carryOver: CarryOver;
  whenBusy: WhenBusy;
  queued: QueuedPolicy;
}

interface FreshDialogProps {
  open: boolean;
  /** "fresh" (Start fresh) or "switch" (Switch provider & mode). */
  kind: FreshDialogKind;
  /** Preselected Carry over; defaults to Nothing (fresh) / Summary (switch). */
  defaultCarryOver?: CarryOver;
  api: Pick<ApiInstance, "listModes" | "getSupportedClis">;
  /** The session being replaced — drives the current mode, the source
   *  channel and the terminal-only guards. */
  session: Session;
  /** Live busy shape from the pane (`ChatPane`/`AgentPaneSlot` write it). */
  busy?: { busy: boolean; queued: number };
  onConfirm: (choice: FreshDialogChoice) => void;
  onCancel: () => void;
}

const CARRY_OPTIONS: { value: CarryOver; name: string; sub: string }[] = [
  {
    value: "none",
    name: "Nothing",
    sub: "Acts like /clear. The chat is emptied; the old one stays under Previous sessions.",
  },
  {
    value: "summary",
    name: "Summary",
    sub: "The current agent writes one first (up to 2 min). Earlier messages stay visible.",
  },
  {
    value: "transcript",
    name: "Transcript",
    sub: "Instant. The new agent reads the old chat from a file. Earlier messages stay visible.",
  },
];

/**
 * The one pane-scoped Start fresh / Switch provider & mode dialog (Decision C).
 *
 * Rendered inside `PaneDialogHost` (a sibling of the permanently mounted
 * `TerminalPane`/`ChatPane`), never through the full-screen `Dialog` portal —
 * the overlay covers only this agent's pane and the terminal never remounts.
 *
 * - `fresh`: all modes, the current one preselected, Carry over = Nothing.
 * - `switch`: the current mode is selected by default and stays selectable (so a
 *   stray pick can be undone); the CTA stays "Pick another mode" until a
 *   different mode is picked. Carry over = Summary / Transcript only. Same-CLI
 *   modes ARE selectable.
 * - Terminal-only target CLIs force the Terminal channel; a terminal source
 *   switching to a Rich-Chat-capable target gets the Terminal / Rich Chat choice.
 * - Mid-turn: Stop now (default) / Let it finish first, plus a "send the queued
 *   messages" checkbox (hidden at 0 queued or when waiting).
 *
 * UI label is "Rich Chat"; the channel value is `"json"` (AGENTS.md).
 */
export function FreshDialog({
  open,
  kind,
  defaultCarryOver,
  api,
  session,
  busy,
  onConfirm,
  onCancel,
}: FreshDialogProps) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [supportedClis, setSupportedClis] = useState<SupportedCli[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedModeId, setSelectedModeId] = useState("");
  const initialCarry: CarryOver =
    defaultCarryOver ?? (kind === "switch" ? "summary" : "none");
  const [carryOver, setCarryOver] = useState<CarryOver>(initialCarry);
  const [channel, setChannel] = useState<"tmux" | "json">(
    session.channel === "json" ? "json" : "tmux",
  );
  const [whenBusy, setWhenBusy] = useState<WhenBusy>("stop");
  const [carryQueued, setCarryQueued] = useState(true);

  const isTerminalSession = session.channel !== "json";
  const isSwitch = kind === "switch";
  const busyNow = !!busy?.busy;
  const queuedCount = busy?.queued ?? 0;

  // Every open starts from the kind's defaults — never a stale pick from a
  // previous session or the other dialog kind.
  useEffect(() => {
    if (!open) return;
    setSelectedModeId(session.modeId ?? "");
    setCarryOver(initialCarry);
    setChannel(session.channel === "json" ? "json" : "tmux");
    setWhenBusy("stop");
    setCarryQueued(true);
  }, [open, isSwitch, initialCarry, session.id, session.modeId, session.channel]);

  // Escape dismisses, like Cancel.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  // Enter confirms (the ref always holds the latest CTA action, or null when the
  // CTA is disabled). Skipped on buttons/links so Enter still activates the
  // focused control, e.g. Cancel.
  const confirmRef = useRef<(() => void) | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      if (e.defaultPrevented || e.keyCode === 229) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      // Only when focus is inside this dialog or nowhere (body): Enter in another
      // pane's composer or any input must never reset this session.
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !rootRef.current?.contains(t)) return;
      if (t?.closest("button, a, textarea, [contenteditable]")) return;
      if (!confirmRef.current) return;
      e.preventDefault();
      confirmRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoadFailed(false);
    void Promise.resolve()
      .then(() => Promise.all([api.listModes(), api.getSupportedClis()]))
      .then(([ms, clis]) => {
        if (cancelled) return;
        setModes(ms);
        setSupportedClis(clis);
        if (!isSwitch && !ms.some((m) => m.id === session.modeId)) {
          setSelectedModeId(ms[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setModes([]);
        setSupportedClis([]);
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, api, isSwitch, session.modeId]);

  const selectedMode = modes.find((m) => m.id === selectedModeId);
  const selectedCli = selectedMode?.cli;
  const selectedSupportsJson = selectedCli
    ? (supportedClis.find((c) => c.id === selectedCli)?.supportsJson ?? false)
    : false;

  // A terminal-only target forces Terminal; a Rich Chat source stays Rich Chat
  // unless the target CLI can't run it. A terminal source picks explicitly.
  const effectiveChannel: "tmux" | "json" = !selectedSupportsJson
    ? "tmux"
    : isTerminalSession
      ? channel
      : "json";

  // A plain (non-tmux) terminal has no scrollback to export — the daemon would
  // 400, so disable Transcript here instead of letting the user hit it.
  const transcriptUnavailable = isTerminalSession && session.useTmux === false;
  const carryChoices = useMemo(
    () =>
      isSwitch
        ? CARRY_OPTIONS.filter((o) => o.value !== "none")
        : CARRY_OPTIONS,
    [isSwitch],
  );

  if (!open) return null;

  const showBusyBlock = busyNow;
  const showQueuedCheckbox =
    showBusyBlock && whenBusy === "stop" && queuedCount > 0;

  // Switch opens with the current mode selected (so a stray tap on another
  // mode can always be undone); switching to the mode you are already on is
  // not a switch, so the CTA stays inactive until a different one is picked.
  const pickedOther = !!selectedMode && selectedMode.id !== session.modeId;

  const title = isSwitch
    ? pickedOther && selectedMode
      ? `Switch to ${selectedMode.name}`
      : "Switch provider & mode"
    : "Start fresh";
  const subtitle = isSwitch
    ? pickedOther && selectedMode
      ? `A new ${selectedMode.name} agent takes over this chat. Pick what it gets from the current one.`
      : "Pick the provider and mode that takes over this chat. The current one hands over what you choose below."
    : "The agent forgets everything. Pick what, if anything, carries over.";

  const cta = isSwitch
    ? pickedOther && selectedMode
      ? `Switch to ${selectedMode.name}`
      : "Pick another mode"
    : showBusyBlock
      ? "Stop and start fresh"
      : "Start fresh";
  const ctaDisabled =
    !selectedMode || !!loadFailed || (isSwitch && !pickedOther);

  const confirm = () => {
    if (!selectedMode || ctaDisabled) return;
    onConfirm({
      modeId: selectedMode.id,
      channel: effectiveChannel,
      carryOver,
      whenBusy: showBusyBlock ? whenBusy : "stop",
      queued: showQueuedCheckbox && !carryQueued ? "drop" : "carry",
    });
  };
  confirmRef.current = ctaDisabled ? null : confirm;

  const hint = showBusyBlock
    ? whenBusy === "wait"
      ? "Waits for the current turn"
      : "Stops the running turn first"
    : carryOver === "summary"
      ? "Summary first, up to 2 min"
      : carryOver === "transcript"
        ? "Transcript linked instantly"
        : "Nothing carried";

  return (
    <div
      ref={rootRef}
      className="fresh-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="fresh-dialog__header">
        <h2 className="fresh-dialog__title">{title}</h2>
        <p className="fresh-dialog__subtitle">{subtitle}</p>
      </div>

      <div className="fresh-dialog__body">
        {showBusyBlock ? (
          <div
            className="fresh-dialog__busy"
            role="group"
            aria-label="The agent is working on a turn."
          >
            <div className="fresh-dialog__busy-title">
              The agent is working on a turn.
            </div>
            <label className="fresh-dialog__busy-row">
              <input
                type="radio"
                name="fresh-when-busy"
                checked={whenBusy === "stop"}
                onChange={() => setWhenBusy("stop")}
              />
              Stop it now and continue (the running turn is lost)
            </label>
            <label className="fresh-dialog__busy-row">
              <input
                type="radio"
                name="fresh-when-busy"
                checked={whenBusy === "wait"}
                onChange={() => setWhenBusy("wait")}
              />
              Let it finish first (can take minutes)
            </label>
            {showQueuedCheckbox ? (
              <label className="fresh-dialog__busy-row">
                <input
                  type="checkbox"
                  checked={carryQueued}
                  onChange={(e) => setCarryQueued(e.target.checked)}
                />
                Send the {queuedCount} queued{" "}
                {queuedCount === 1 ? "message" : "messages"} to the new agent
              </label>
            ) : null}
          </div>
        ) : null}

        <div className="fresh-dialog__group">
          <div className="fresh-dialog__label">Provider &amp; mode</div>
          {loadFailed ? (
            <p className="fresh-dialog__error">
              Couldn't load modes — close this and try again.
            </p>
          ) : (
            <div
              className="fresh-dialog__list"
              role="radiogroup"
              aria-label="Provider and mode"
            >
              {modes.map((m) => {
                const isCurrent = m.id === session.modeId;
                const supports =
                  supportedClis.find((c) => c.id === m.cli)?.supportsJson ??
                  false;
                const meta = [cliDisplayName(m.cli), m.model]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={m.id === selectedModeId}
                    className={
                      "fresh-dialog__mode" +
                      (m.id === selectedModeId ? " fresh-dialog__mode--on" : "")
                    }
                    onClick={() => setSelectedModeId(m.id)}
                  >
                    <span className="fresh-dialog__radio" aria-hidden="true" />
                    <ModeIcon
                      iconKey={m.icon}
                      channel={supports ? "json" : "tmux"}
                      size={14}
                    />
                    <span className="fresh-dialog__mode-name">{m.name}</span>
                    {isCurrent ? (
                      <span className="fresh-dialog__chip fresh-dialog__chip--current">
                        Current
                      </span>
                    ) : null}
                    {!supports ? (
                      <span className="fresh-dialog__chip fresh-dialog__chip--warn">
                        Terminal only
                      </span>
                    ) : null}
                    <span className="fresh-dialog__mode-meta">{meta}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="fresh-dialog__group">
          <div className="fresh-dialog__label">Carry over to the new agent</div>
          <div className="fresh-dialog__list">
            {carryChoices.map((o) => {
              const disabled =
                o.value === "transcript" && transcriptUnavailable;
              const sub =
                o.value === "transcript" &&
                isTerminalSession &&
                !transcriptUnavailable
                  ? `${o.sub} (scrollback export, rough)`
                  : disabled
                    ? "Not available for plain terminals"
                    : o.sub;
              return (
                <label
                  key={o.value}
                  className={
                    "fresh-dialog__opt" +
                    (carryOver === o.value ? " fresh-dialog__opt--on" : "") +
                    (disabled ? " fresh-dialog__opt--disabled" : "")
                  }
                >
                  <input
                    type="radio"
                    name="fresh-carry"
                    value={o.value}
                    checked={carryOver === o.value}
                    disabled={disabled}
                    onChange={() => setCarryOver(o.value)}
                  />
                  <span className="fresh-dialog__opt-body">
                    <span className="fresh-dialog__opt-name">{o.name}</span>
                    <span className="fresh-dialog__opt-sub">{sub}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {isTerminalSession && selectedSupportsJson ? (
          <div className="fresh-dialog__group">
            <div className="fresh-dialog__label">Continue as</div>
            <div
              className="fresh-dialog__seg"
              role="group"
              aria-label="Continue as"
            >
              <button
                type="button"
                className={
                  "fresh-dialog__seg-btn" +
                  (effectiveChannel === "tmux"
                    ? " fresh-dialog__seg-btn--on"
                    : "")
                }
                aria-pressed={effectiveChannel === "tmux"}
                onClick={() => setChannel("tmux")}
              >
                Terminal
              </button>
              <button
                type="button"
                className={
                  "fresh-dialog__seg-btn" +
                  (effectiveChannel === "json"
                    ? " fresh-dialog__seg-btn--on"
                    : "")
                }
                aria-pressed={effectiveChannel === "json"}
                onClick={() => setChannel("json")}
              >
                Rich Chat
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="fresh-dialog__footer">
        <span className="fresh-dialog__hint">{hint}</span>
        <span className="fresh-dialog__spacer" />
        <button type="button" className="fresh-dialog__btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="fresh-dialog__btn fresh-dialog__btn--primary"
          disabled={ctaDisabled}
          onClick={confirm}
        >
          {cta}
        </button>
      </div>
    </div>
  );
}
