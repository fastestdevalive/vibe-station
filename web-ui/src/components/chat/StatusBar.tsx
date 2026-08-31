import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { SessionMeta, TurnState } from "@/api/types";
import { ModelSwitch } from "./ModelSwitch";
import { ChannelToggleButton } from "./ChannelToggleButton";
import { WorkingDots } from "./WorkingDots";

interface StatusBarProps {
  meta: SessionMeta | null;
  /** Optimistic queued count (pending bubbles) merged with meta.queueDepth. */
  queueDepth?: number;
  /** Runs while a turn is active. */
  onStop?: () => void;
  /** When provided (with sessionId), the model becomes a live switcher. */
  api?: ApiInstance;
  sessionId?: string;
  /** Whether the message list is scrolled to (or near) the live edge, mirrored
   *  up from `MessageList` by `ChatPane`. While busy AND scrolled away, the
   *  in-feed `WorkingIndicator` is off-screen, so the footer shows the same
   *  animated dots next to Stop; at the bottom it stays dots-free (the in-feed
   *  indicator already covers it). Defaults to `true` — no busy dots — so
   *  callers that don't track scrolling are unaffected. */
  atBottom?: boolean;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

const BUSY_STATES: TurnState[] = ["thinking", "responding", "tool"];

/** Shared with `MessageList`'s `WorkingIndicator` (Decision 8) — one source of
 *  truth for the turn-state label text instead of duplicating this switch.
 *
 *  The busy labels carry NO trailing "…": they render next to the
 *  `WorkingIndicator`'s animated `•••`, so an ellipsis would read as "dots,
 *  then more dots". The non-busy labels ("Ready" / "Queued (n)" / "Error")
 *  never render beside the dots and are unaffected. */
export function turnLabel(state: TurnState | undefined, queue: number): string {
  switch (state) {
    case "thinking":
      return "Thinking";
    case "responding":
      return "Responding";
    case "tool":
      return "Running tool";
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
export function StatusBar({ meta, queueDepth = 0, onStop, api, sessionId, atBottom = true }: StatusBarProps) {
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

  // Resolve the CLI's native-history-import capability (first-class flag from
  // GET /supported-clis) so we can warn before a lossy switch. null = unknown;
  // we default to NOT warning until it resolves. cursor/agy → false.
  const cli = meta?.cli;
  const [importsHistory, setImportsHistory] = useState<boolean | null>(null);
  // Same resolve-once-from-GET/supported-clis pattern as importsHistory above,
  // for a second, independent caveat: can the terminal side actually RESUME
  // this CLI's conversation at all (vs. just missing its terminal-phase
  // backfill). false only for cursor today — its ACP session state lives in a
  // store `--resume` can't read (Decision 6 follow-up, spawn.ts).
  const [supportsResume, setSupportsResume] = useState<boolean | null>(null);
  useEffect(() => {
    if (!api || !cli) return undefined;
    setImportsHistory(null);
    setSupportsResume(null);
    let live = true;
    void api.getSupportedClis().then((clis) => {
      if (!live) return;
      const entry = clis.find((c) => c.id === cli);
      setImportsHistory(entry?.importsNativeHistory ?? true);
      setSupportsResume(entry?.supportsJsonToTerminalResume ?? true);
    });
    return () => {
      live = false;
    };
  }, [api, cli]);

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
      </div>
      <div className="chat-statusbar__turn">
        {/* While busy, the SAME label already rides next to the in-feed
         *  `WorkingIndicator`'s dots (Decision 8) — repeating it here, beside
         *  the Stop button, is pure duplication, so the busy footer row is
         *  just `[Stop]`. Non-busy states ("Ready" / "Queued (n)" / "Error")
         *  have no in-feed counterpart and still render here. `error` is
         *  never a busy state, so the ⚠ icon is unaffected. */}
        {busy ? null : (
          <span className={`chat-statusbar__state chat-statusbar__state--${state ?? "idle"}`}>
            {state === "error" ? <span aria-hidden>⚠ </span> : null}
            {turnLabel(state, queue)}
          </span>
        )}
        {/* Dots ONLY (never the busy label — that would re-create the exact
         *  duplication removed above), and visible only while the in-feed
         *  indicator is actually out of view. This is the sole "still working"
         *  affordance left for a user who has scrolled up.
         *
         *  The element stays MOUNTED for the whole busy period and only toggles
         *  visibility: mounting/unmounting it would resize the row and shove
         *  the Stop button sideways every time the user crosses the 80px
         *  near-bottom threshold — i.e. exactly while they are scrolling.
         *  `visibility: hidden` (not `display: none`) keeps the box, so the
         *  reserved space is identical either way. `aria-hidden` while
         *  invisible keeps it out of the a11y tree, matching the visual. */}
        {busy ? (
          <span
            className={`chat-statusbar__busy${atBottom ? " chat-statusbar__busy--hidden" : ""}`}
            role="status"
            aria-label="Agent is working"
            {...(atBottom ? { "aria-hidden": true } : {})}
          >
            <WorkingDots />
          </span>
        ) : null}
        {busy && onStop ? (
          <button type="button" className="chat-statusbar__stop btn btn--secondary" onClick={onStop}>
            Stop
          </button>
        ) : null}
      </div>
      {/* Positioned via CSS as a top-right overlay of the whole `.chat-pane`
          (item 4) — NOT visually anchored to this row, even though it's
          declared here alongside the rest of the toggle's gating logic. */}
      {canToggle ? (
        <ChannelToggleButton
          api={api!}
          sessionId={sessionId!}
          direction="toTerminal"
          triggerDisabled={!idle}
          confirmBlocked={!idle}
          blockedMessage="The session just went busy — wait for it to finish (or clear the queue) before switching."
          {...(() => {
            const warnings = [
              supportsResume === false
                ? `⚠ ${cli} can't resume in the terminal — this switch starts a FRESH terminal conversation instead of continuing this one. Your Rich Chat history stays intact and untouched.`
                : null,
              importsHistory === false
                ? `⚠ ${cli} can't read its terminal history yet — anything you do in the terminal won't appear back in Rich Chat, though the agent still remembers it.`
                : null,
            ].filter((w): w is string => w !== null);
            return warnings.length > 0 ? { warning: warnings.join("\n\n") } : {};
          })()}
        />
      ) : null}
    </div>
  );
}
