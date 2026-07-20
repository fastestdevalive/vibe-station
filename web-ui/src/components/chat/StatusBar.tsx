import { useState } from "react";
import type { ApiInstance } from "@/api";
import type { SessionMeta, TurnState } from "@/api/types";
import { ModelSwitch } from "./ModelSwitch";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";

interface StatusBarProps {
  meta: SessionMeta | null;
  /** Optimistic queued count (pending bubbles) merged with meta.queueDepth. */
  queueDepth?: number;
  /** Runs while a turn is active. */
  onStop?: () => void;
  /** When provided (with sessionId), the model becomes a live switcher. */
  api?: ApiInstance;
  sessionId?: string;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

const BUSY_STATES: TurnState[] = ["thinking", "responding", "tool"];

function turnLabel(state: TurnState | undefined, queue: number): string {
  switch (state) {
    case "thinking":
      return "Thinking…";
    case "responding":
      return "Responding…";
    case "tool":
      return "Running tool…";
    case "queued":
      return `Queued (${queue})`;
    case "error":
      return "Error";
    default:
      return "Ready";
  }
}

/**
 * Composer status bar: tokens used / context %, model, mode name, and a live
 * turn-state indicator (Decision 4 — one cross-harness contract, no per-CLI
 * branching). Fields absent from `meta` (e.g. costUsd, contextWindow) hide
 * gracefully.
 */
export function StatusBar({ meta, queueDepth = 0, onStop, api, sessionId }: StatusBarProps) {
  const usage = meta?.usage;
  const state = meta?.turnState;
  const queue = Math.max(queueDepth, meta?.queueDepth ?? 0);
  const busy = state ? BUSY_STATES.includes(state) : false;

  const total = usage?.totalTokens ?? 0;
  const ctx = usage?.contextWindow;
  const pct = ctx && ctx > 0 ? Math.round((total / ctx) * 100) : null;

  const model = meta?.model ?? usage?.model;

  // Channel toggle (P3, R1.1): the chat pane can switch a JSON session to a raw
  // terminal (same agentChatId, --resume). Enabled ONLY when idle — no active,
  // queued, or held-for-edit turn.
  const canToggle = !!(api && sessionId && meta && meta.channel === "json");
  const idle = state === "idle" && queue === 0 && (meta?.editingTurnIds.length ?? 0) === 0;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const doToggle = async () => {
    if (!api || !sessionId) return;
    setToggling(true);
    setToggleError(null);
    try {
      await api.setSessionChannel(sessionId, "tmux");
      setConfirmOpen(false);
    } catch {
      // Most commonly a 409 (a turn started between the click and confirm).
      setToggleError("Couldn't switch — the session is busy. Try again when idle.");
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="chat-statusbar" data-turn-state={state ?? "idle"}>
      <div className="chat-statusbar__info">
        {usage ? (
          <span className="chat-statusbar__tokens">
            {ctx ? `${fmt(total)} / ${fmt(ctx)} tok` : `${fmt(total)} tok`}
            {pct != null ? <span className="chat-statusbar__pct"> ({pct}%)</span> : null}
          </span>
        ) : null}
        {usage?.costUsd != null ? (
          <span className="chat-statusbar__cost">${usage.costUsd.toFixed(3)}</span>
        ) : null}
        {api && sessionId && meta && meta.cli !== "cursor" ? (
          <ModelSwitch api={api} sessionId={sessionId} cli={meta.cli} model={model} />
        ) : model ? (
          <span className="chat-statusbar__model">{model}</span>
        ) : null}
        {meta?.modeName ? <span className="chat-statusbar__mode">{meta.modeName}</span> : null}
        {canToggle ? (
          <button
            type="button"
            className="chat-statusbar__channel"
            onClick={() => setConfirmOpen(true)}
            disabled={!idle}
            title={
              idle
                ? "Switch this session to a raw terminal (keeps the same conversation)"
                : "Finish or clear the queue before switching channel"
            }
          >
            ⇄ Terminal
          </button>
        ) : null}
      </div>
      <div className="chat-statusbar__turn">
        <span className={`chat-statusbar__state chat-statusbar__state--${state ?? "idle"}`}>
          {busy ? <span className="chat-spinner" aria-hidden /> : null}
          {state === "error" ? <span aria-hidden>⚠ </span> : null}
          {turnLabel(state, queue)}
        </span>
        {busy && onStop ? (
          <button type="button" className="chat-statusbar__stop btn btn--secondary" onClick={onStop}>
            Stop
          </button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Switch to terminal?"
        message={
          toggleError ??
          "This closes the JSON chat and reopens the same conversation in a raw terminal (resumed via --resume). You can switch back to JSON chat from the terminal — your terminal-phase turns will be backfilled here."
        }
        confirmLabel={toggling ? "Switching…" : "Switch to terminal"}
        onConfirm={() => void doToggle()}
        onCancel={() => {
          setConfirmOpen(false);
          setToggleError(null);
        }}
      />
    </div>
  );
}
