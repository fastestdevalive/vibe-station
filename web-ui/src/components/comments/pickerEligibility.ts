import type { Session, SessionState, TerminalReadiness } from "@/api/types";
import { draftLabel, sessionLabel } from "@/lib/sessionLabel";

/** What the send picker can do with one agent (PRD R62; the delivery-time probe is the real gate, this is a hint). */
export type PickerChip = "Rich Chat" | "Terminal" | "Terminal (pty)" | "Draft";

export interface PickerRowModel {
  id: string;
  name: string;
  chip: PickerChip;
  /** `rich` rows take Send / Attach / clock; `terminal` rows Send / clock; the rest nothing. */
  target: "rich" | "terminal" | "none";
  state: SessionState;
  /** The state / reason text next to the chip (`working · queues`, `not supported`, ...). */
  why: string;
  /** `done` agents send with a warning; shown in `--fg-warning`. */
  warn: boolean;
  disabled: boolean;
  canSend: boolean;
  canAttach: boolean;
  canSchedule: boolean;
  /**
   * Still settling: a Terminal row whose CLI capability or readiness probe has not answered yet. The picker's
   * default selection waits for the focused agent's row instead of falling through to another agent.
   */
  pending?: boolean;
  /** A Terminal row whose eligibility depends on the readiness probe (an idle tmux agent sits in `waiting_for_human`). */
  probe?: boolean;
}

export interface PickerRowInput {
  session: Session;
  /** `sessionStates[id] ?? session.state`, never `.lifecycleState`. */
  state: SessionState;
  /** The mode's CLI `supportsTerminalComments`; `undefined` while the CLI list is still loading. */
  supportsTerminalComments: boolean | undefined;
  /** The session's mode no longer exists (a Terminal paste needs it to find the CLI's probe). */
  modeMissing: boolean;
  /** `GET /sessions/:id/terminal-readiness`; `undefined` = not read (yet) or unknown. */
  readiness?: TerminalReadiness;
  /** The readiness probe was asked and has not answered yet (used only for `pending`). */
  readinessPending?: boolean;
}

const OFF = { canSend: false, canAttach: false, canSchedule: false } as const;

/** Build one picker row from the session, its LIVE state and the Terminal capability hints (the eligibility table). */
export function buildPickerRow(input: PickerRowInput): PickerRowModel {
  const { session, state, supportsTerminalComments, modeMissing, readiness, readinessPending } = input;
  const base = { id: session.id, state, warn: false };

  if (state === "drafting") {
    return { ...base, name: draftLabel(session.draftPrompt), chip: "Draft", target: "none", why: "drafting · not started", disabled: true, ...OFF };
  }

  if (session.channel === "json") {
    const row = { ...base, name: sessionLabel(session), chip: "Rich Chat" as const, target: "rich" as const, disabled: false };
    const on = { canSend: true, canAttach: true, canSchedule: true };
    switch (state) {
      case "idle":
        return { ...row, why: "idle", ...on };
      case "working":
        return { ...row, why: "working · queues", ...on };
      case "not_started":
        return { ...row, why: "starting · queues", ...on };
      case "waiting_for_human":
        return { ...row, why: "needs you · queues", ...on };
      case "exited":
        return { ...row, why: "exited · resumes on send", ...on };
      case "done":
        return { ...row, why: "marked done · sends with warning", warn: true, ...on };
    }
  }

  const name = sessionLabel(session);
  const off = (why: string, chip: PickerChip = "Terminal"): PickerRowModel => ({
    ...base,
    name,
    chip,
    target: "none",
    why,
    disabled: true,
    ...OFF,
  });

  if (session.channel === "pty") return off("not supported", "Terminal (pty)");
  if (modeMissing) return off("mode no longer exists");
  if (supportsTerminalComments === undefined) return { ...off("checking support…"), pending: true };
  if (!supportsTerminalComments) return off("not supported");
  if (state === "exited") return off("exited");
  if (state === "done") return off("marked done");
  if (state === "waiting_for_human" && readiness !== "ready") {
    if (readiness === "awaiting_approval") return off("awaiting approval");
    if (readinessPending) return { ...off("checking…"), pending: true, probe: true };
    return off("awaiting approval / unknown");
  }
  if (readiness === "awaiting_approval") return off("awaiting approval");

  const row: PickerRowModel = {
    ...base,
    name,
    chip: "Terminal",
    target: "terminal",
    why: "",
    disabled: false,
    canSend: true,
    canAttach: false,
    canSchedule: true,
    ...(readinessPending ? { pending: true } : {}),
  };
  if (state === "working" || state === "not_started") return { ...row, why: "working · waits for ready" };
  return { ...row, why: readiness === "ready" ? "ready" : "idle" };
}

/** Does the row need a readiness probe when the picker opens (only Terminal rows that can still send)? */
export function wantsReadiness(row: PickerRowModel): boolean {
  return row.target === "terminal" || row.probe === true;
}
