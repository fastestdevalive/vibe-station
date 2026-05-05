import type { WorktreeRolledUpStatus } from "@/lib/worktreeStatus";

const GLYPH: Record<WorktreeRolledUpStatus, string> = {
  working: "●",
  spawning: "◐",
  idle: "○",
  done: "✓",
  exited: "×",
  none: "·",
};

export function StatusDot({ status }: { status: WorktreeRolledUpStatus }) {
  const glyph = GLYPH[status];
  return (
    <span
      className={`status-dot status-dot--${status}`}
      aria-label={`status: ${status}`}
      title={status}
    >
      {glyph}
    </span>
  );
}
