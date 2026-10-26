import { useState } from "react";
import type { CarryOver } from "@/api/types";
import { ModeIcon } from "@/components/agent/ModeIcon";

/** Provider chip in a legacy (pre-`carryOver`) switch card — mono provider id
 *  with its brand glyph, matching the design's chip-mono. */
function ProviderChip({ provider }: { provider: string }) {
  return (
    <span className="chat-session-break__chip">
      <ModeIcon iconKey={provider} size={11} />
      {provider}
    </span>
  );
}

/** Mode pill in a `carryOver` switch card — mode display name with the CLI's
 *  brand glyph (`fromProvider`/`toProvider` are still CLI strings). */
function ModePill({ mode, provider }: { mode: string; provider?: string }) {
  return (
    <span className="chat-session-break__pill">
      <ModeIcon iconKey={provider ?? null} size={11} />
      {mode}
    </span>
  );
}

/**
 * Reset / switch divider between two chat eras.
 *
 * With `carryOver` (new rows): "Fresh start" for a same-mode restart, or
 * "Switched to <toMode>" plus `<fromMode> → <toMode>` pills; the sub-line says
 * what was carried ("Summary carried over" / "Transcript linked"), and the
 * toggle reads "Show summary" / "Show instruction".
 *
 * Without `carryOver` (rows written before the carry-mode change) the previous
 * rendering is kept so old transcripts still read correctly.
 */
export function SessionBreakCard({
  kind,
  carryOver,
  fromMode,
  toMode,
  fromProvider,
  toProvider,
  text,
  ts,
  onOpenPrevious,
}: {
  kind: "reset" | "switch";
  /** How much history was carried — absent on rows written before the change. */
  carryOver?: CarryOver;
  /** Display name of the mode being replaced / the replacement mode. */
  fromMode?: string;
  toMode?: string;
  fromProvider?: string;
  toProvider?: string;
  /** The summary or transcript instruction passed to the next agent. */
  text?: string;
  /** RFC-3339 timestamp of the break, formatted as the card's time. */
  ts?: string;
  /** Opens the Previous sessions dialog for this pane. */
  onOpenPrevious?: () => void;
}) {
  const [showText, setShowText] = useState(false);
  const isSwitch = kind === "switch";
  const hasText = typeof text === "string" && text.trim().length > 0;
  const isTranscript = carryOver === "transcript";

  let time: string | undefined;
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  const title =
    carryOver !== undefined
      ? isSwitch
        ? `Switched to ${toMode ?? toProvider ?? "another mode"}`
        : "Fresh start"
      : isSwitch
        ? "Switched provider"
        : "Agent restarted";

  const sub =
    carryOver !== undefined
      ? isTranscript
        ? "Transcript linked. The new agent can read the earlier chat from a file."
        : "Summary carried over. The new agent can't see the messages above this line."
      : isSwitch
        ? `History kept.${hasText ? " The new agent received a summary." : ""}`
        : `Earlier messages are above.${hasText ? " The new agent was given a summary." : ""}`;

  const toggleLabel = carryOver !== undefined
    ? isTranscript
      ? showText ? "Hide instruction" : "Show instruction"
      : showText ? "Hide summary" : "Show summary"
    : showText ? "Hide summary" : "Show summary";

  return (
    <div className="chat-session-break" role="note">
      <div className="chat-session-break__rule" aria-hidden="true" />
      <div className={`chat-session-break__card${isSwitch ? " chat-session-break__card--switch" : ""}`}>
        <div className="chat-session-break__row">
          {isSwitch ? (
            <svg className="chat-session-break__ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 5.5h10.5M10 3l2.5 2.5L10 8" />
              <path d="M14 10.5H3.5M6 8l-2.5 2.5L6 13" />
            </svg>
          ) : (
            <svg className="chat-session-break__ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1" />
              <path d="M2.5 2.5v3h3" />
            </svg>
          )}
          <span className="chat-session-break__title">{title}</span>
          {time ? <span className="chat-session-break__time">{time}</span> : null}
        </div>

        {carryOver !== undefined
          ? isSwitch && fromMode && toMode
            ? (
                <div className="chat-session-break__providers">
                  <ModePill mode={fromMode} provider={fromProvider} />
                  <svg className="chat-session-break__arrow" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" />
                  </svg>
                  <ModePill mode={toMode} provider={toProvider} />
                </div>
              )
            : null
          : isSwitch && fromProvider && toProvider
            ? (
                <div className="chat-session-break__providers">
                  <ProviderChip provider={fromProvider} />
                  <svg className="chat-session-break__arrow" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" />
                  </svg>
                  <ProviderChip provider={toProvider} />
                </div>
              )
            : null}

        <div className="chat-session-break__sub">{sub}</div>

        <div className="chat-session-break__actions">
          {hasText ? (
            <button
              type="button"
              className="chat-session-break__toggle"
              aria-expanded={showText}
              onClick={() => setShowText((v) => !v)}
            >
              {toggleLabel}
            </button>
          ) : null}
          {onOpenPrevious ? (
            <button type="button" className="chat-session-break__toggle" onClick={onOpenPrevious}>
              Previous sessions
            </button>
          ) : null}
        </div>

        {hasText && showText ? <div className="chat-session-break__summary">{text}</div> : null}
      </div>
      <div className="chat-session-break__rule" aria-hidden="true" />
    </div>
  );
}
