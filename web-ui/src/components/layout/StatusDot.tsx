import type { PrStatus } from "@/api/types";
import type { WorktreeRolledUpStatus } from "@/lib/worktreeStatus";
import { resolveStatusClass } from "@/lib/statusColor";

/** Raw-lifecycle glyph fallback — used whenever the PR axis doesn't produce
 *  a distinct resolved state (see `StatusDot` below). */
const GLYPH: Record<WorktreeRolledUpStatus, string> = {
  waiting_for_human: "!",
  working: "●",
  spawning: "◐",
  idle: "○",
  done: "✓",
  exited: "×",
  none: "·",
};

interface StatusDotProps {
  status: WorktreeRolledUpStatus;
  /** PR axis for this worktree/session — `resolveStatusClass` folds it into
   *  the lifecycle status. Defaults to `null` (no PR) for callers that don't
   *  track a PR at all (e.g. terminal sessions). */
  pr?: PrStatus | null;
}

/**
 * One indicator, not two (D17/D18/5.8-5.9, superseding the separate
 * `PrBadge`) — the same `●` dot is recolored by `resolveStatusClass` for
 * `working` (yellow), `pr-open` (blue), `pr-merged` (green). Because D18
 * lets an open/merged PR outrank `waiting_for_human`, the resolved state can
 * differ from the raw `status` prop — e.g. `waiting_for_human` + an open PR
 * resolves to `pr-open` and renders the round dot, not the waiting `!`
 * (the PR is the fresher signal; see `resolveStatusClass`'s doc comment).
 * `title`/`aria-label` always name the resolved state so this isn't
 * colour-only (5.9's accepted trade-off note).
 */
export function StatusDot({ status, pr = null }: StatusDotProps) {
  const resolved = resolveStatusClass(status, pr);
  const isColoredDot = resolved === "working" || resolved === "pr-open" || resolved === "pr-merged";
  // Terminal lifecycle (done/exited) always keeps its own glyph, regardless
  // of what colour the PR axis resolves to — D21 only ever meant to recolour
  // the dot, never to destroy the ✓/× "this is finished" cue (see
  // docs/STATUS-INDICATORS.md's non-colour-cues note).
  const isTerminal = status === "done" || status === "exited";
  const glyph = isTerminal
    ? GLYPH[status]
    : isColoredDot
      ? "●"
      : resolved === "waiting_for_human"
        ? "!"
        : GLYPH[status];
  const label = resolved ?? status;
  return (
    <span
      className={`status-dot status-dot--${label}`}
      aria-label={`status: ${label}`}
      title={label}
    >
      {glyph}
    </span>
  );
}
