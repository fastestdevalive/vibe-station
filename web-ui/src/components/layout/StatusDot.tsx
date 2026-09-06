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
 * One indicator, not two (D17/D18/5.8-5.9) — `resolveStatusClass` folds
 * lifecycle + PR axes into a single resolved class. The `working` state
 * renders as a circular spinner; all other states use a glyph dot.
 * Terminal states (done/exited) always keep their ✓/× glyph regardless of PR.
 */
export function StatusDot({ status, pr = null }: StatusDotProps) {
  const resolved = resolveStatusClass(status, pr);

  if (resolved === "working") {
    const prMod =
      pr?.state === "merged" ? " status-spinner--pr-merged"
      : pr?.state === "open" ? " status-spinner--pr-open"
      : "";
    return (
      <span
        className={`status-spinner${prMod}`}
        aria-label="status: working"
        title="working"
      />
    );
  }

  const label = resolved ?? status;
  const isTerminal = status === "done" || status === "exited";
  const isColoredDot = resolved === "pr-open" || resolved === "pr-merged";
  const glyph = isTerminal
    ? GLYPH[status]
    : isColoredDot
      ? "●"
      : resolved === "waiting_for_human"
        ? "!"
        : GLYPH[status];

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
