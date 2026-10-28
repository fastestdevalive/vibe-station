/** Schedule UI copy that more than one component shows (one definition each). */
export const SCHEDULE_COPY = {
  unsupported: "Scheduling isn't supported for this agent yet",
  agentNotRunning: "Agent isn't running",
} as const;

/** `1 comment` / `N comments`. */
export function commentCountLabel(n: number): string {
  return n === 1 ? "1 comment" : `${n} comments`;
}
