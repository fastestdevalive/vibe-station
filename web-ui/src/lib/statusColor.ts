import type { PrStatus, Session } from "@/api/types";
import type { WorktreeRolledUpStatus } from "@/lib/worktreeStatus";

/**
 * PR axis rendering — pure, no React. Reads a worktree's `pr` from its
 * `isMain` session (matches how `daemon/src/services/prPoller.ts` picks the
 * session it writes `session.pr` to, K9) and combines it with the lifecycle
 * axis into a single CSS class suffix for the tile/pane border.
 */

/**
 * The `isMain` session's `pr`, filtered to the worktree's CURRENT branch
 * (D20) — `null` when there is no main session, no PR, or the PR was last
 * checked against a branch the worktree has since moved off of (a branch
 * switch must never show a stale PR colour before the next poll tick).
 */
export function worktreePrStatus(sessions: Session[], currentBranch: string): PrStatus | null {
  const main = sessions.find((s) => s.isMain);
  const pr = main?.pr;
  if (!pr) return null;
  if (pr.prBranch !== currentBranch) return null;
  return pr;
}

/**
 * Resolve the CSS class SUFFIX for a tile/pane border AND the `StatusDot`
 * glyph/color (matches the existing `workspace-canvas__tile--${x}` /
 * `agent-pane-slot--${x}` convention) — never a hex color or a `var(...)`
 * string.
 *
 * Precedence (D17/D18), strictly in this order:
 *   1. `working` (lifecycle) — active work is the freshest signal, beats
 *      even a merged PR (agent asked to keep working on the branch)
 *   2. `pr.state === "merged"` → `"pr-merged"`
 *   3. `pr.state === "open"` → `"pr-open"`
 *   4. `waiting_for_human` (lifecycle) — this INVERTS the old R7 rule: a PR
 *      now beats waiting_for_human, since the agent idles at its prompt
 *      right after opening a PR, so red would otherwise mask blue
 *      permanently
 *   5. `idle` (lifecycle)
 *   6. `null`
 *
 * `pr.state === "draft"` and `"closed"` never drive the border.
 *
 * `done`/`exited` are terminal for BUCKETING (D19 — `bucketForRollup` sends
 * them to "finished" unconditionally) but **do inherit the PR color** (D21):
 * a landed branch should still read as blue/green so you can see the work
 * shipped, even though the card sits in Finished. Colour and bucket
 * deliberately disagree here — see `docs/STATUS-INDICATORS.md`. With no PR,
 * `done` resolves to `null` and `exited` to its own literal class, which
 * exists only for the pre-existing non-color dimming cue
 * (`workspace-canvas__tile--exited{opacity:.9}`). `spawning` (the rolled-up form
 * of `not_started`) is likewise left as its own literal, non-colored class
 * so its dashed-border cue survives — see the pr-status-axis Phase 5 report
 * for why this doesn't fold `not_started` into the `working` color the way
 * D17's table literally reads; flagged there as an open question rather
 * than guessed silently.
 */
export function resolveStatusClass(
  lifecycle: WorktreeRolledUpStatus,
  pr: PrStatus | null,
): string | null {
  // D21 — terminal states inherit the PR colour when the branch landed;
  // otherwise neutral. Bucketing still forces them to "finished".
  if (lifecycle === "done" || lifecycle === "exited") {
    if (pr?.state === "merged") return "pr-merged";
    if (pr?.state === "open") return "pr-open";
    return lifecycle === "exited" ? "exited" : null;
  }
  if (lifecycle === "working") return "working";
  if (pr?.state === "merged") return "pr-merged";
  if (pr?.state === "open") return "pr-open";
  if (lifecycle === "waiting_for_human") return "waiting_for_human";
  if (lifecycle === "idle") return "idle";
  if (lifecycle === "spawning") return "spawning";
  return null;
}
