import type { TaskState, TaskSummary } from "@/api/types";

/** A running command with no activity for this long is DISPLAYED as quiet (never filtered; plan U5). */
export const QUIET_AFTER_MS = 2 * 60_000;
const MAX_CHIP_LABELS = 3;
const MAX_CHIP_LABEL_CHARS = 24;

export function toMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** Commands only: running, but no output/activity for {@link QUIET_AFTER_MS}. */
export function isQuiet(t: TaskSummary, now: number): boolean {
  // Only file-output commands: for others the daemon does not broadcast activity, so "quiet" would be a guess.
  if (t.state !== "running" || t.kind !== "command" || t.outputKind !== "file") return false;
  const last = toMs(t.lastActivityAt) ?? toMs(t.startedAt);
  return last !== undefined && now - last > QUIET_AFTER_MS;
}

export interface TaskGroups {
  /** Every `running` task, quiet ones included, in daemon order. */
  live: TaskSummary[];
  /** Running and not quiet — drives the accent spinner and "N running". */
  running: TaskSummary[];
  quiet: TaskSummary[];
  /** Done / failed / stopped / stale, newest end first. */
  finished: TaskSummary[];
}

export function groupTasks(tasks: readonly TaskSummary[] | undefined, now: number): TaskGroups {
  const live: TaskSummary[] = [];
  const running: TaskSummary[] = [];
  const quiet: TaskSummary[] = [];
  const finished: TaskSummary[] = [];
  for (const t of tasks ?? []) {
    if (t.state === "running") {
      live.push(t);
      (isQuiet(t, now) ? quiet : running).push(t);
    } else {
      finished.push(t);
    }
  }
  finished.sort((a, b) => (toMs(b.endedAt) ?? toMs(b.startedAt) ?? 0) - (toMs(a.endedAt) ?? toMs(a.startedAt) ?? 0));
  return { live, running, quiet, finished };
}

/** "38s", "4m 12s", "1h 5m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Coarse "3m" / "45s" for quiet text and "last output … ago". */
export function formatAge(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** `m:ss` for chip labels. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function kindName(t: Pick<TaskSummary, "kind">): string {
  return t.kind === "command" ? "Background command" : t.kind === "monitor" ? "Monitor" : "Subagent";
}

/** Lower-case noun used in compact rows. */
export function kindShort(t: Pick<TaskSummary, "kind">): string {
  return t.kind === "command" ? "command" : t.kind;
}

function endedElapsed(t: TaskSummary): number | undefined {
  const s = toMs(t.startedAt);
  const e = toMs(t.endedAt);
  return s !== undefined && e !== undefined ? e - s : undefined;
}

/** Per-kind status sentence (header, tooltips). Stale/Failed carry `reason` as text; a running row's reason is appended. */
export function stateText(t: TaskSummary, now: number): string {
  const kind = kindName(t);
  const startedMs = toMs(t.startedAt);
  const reason = t.reason ? ` (${t.reason})` : "";
  switch (t.state) {
    case "running": {
      // A running row carries a reason only once its hold lapsed (no longer counted as agent work).
      const why = t.reason ? ` · ${t.reason}` : "";
      if (isQuiet(t, now)) {
        const last = toMs(t.lastActivityAt) ?? startedMs ?? now;
        return `No new output for ${formatAge(now - last)} — may have finished${why}`;
      }
      return `${kind} · running ${formatElapsed(startedMs !== undefined ? now - startedMs : 0)}${why}`;
    }
    case "done": {
      const d = endedElapsed(t);
      return `${kind} · done${d !== undefined ? ` in ${formatElapsed(d)}` : ""}`;
    }
    case "failed":
      return `${kind} · failed${t.reason ? `: ${t.reason}` : ""}`;
    case "stopped":
      return `${kind} · stopped${reason}`;
    case "stale":
      return t.kind === "command" ? `Ended or unknown${t.reason ? ` · ${t.reason}` : ""}` : `${kind} · ended or unknown${reason}`;
  }
}

/** One-word state used in accessible names. */
export function stateWord(state: TaskState, quiet: boolean): string {
  if (state === "running") return quiet ? "quiet" : "running";
  return state === "stale" ? "ended or unknown" : state;
}

/** Compact right-hand text of a tray row. */
export function rowMeta(t: TaskSummary, now: number): string {
  const startedMs = toMs(t.startedAt);
  if (t.state === "running") {
    if (isQuiet(t, now)) return "quiet";
    return startedMs !== undefined ? formatElapsed(now - startedMs) : "";
  }
  if (t.state === "done") {
    const d = endedElapsed(t);
    return d !== undefined ? `done ${formatElapsed(d)}` : "done";
  }
  if (t.state === "stale") return "ended?";
  return t.state;
}

/** Accessible name of a tray row button: `label, kind, state, elapsed[, reason]`. */
export function rowAriaLabel(t: TaskSummary, now: number): string {
  const q = isQuiet(t, now);
  return [t.label, kindShort(t), stateWord(t.state, q), rowMeta(t, now), t.reason].filter(Boolean).join(", ");
}

/** First two whitespace tokens of a command, ≤24 chars; other kinds just truncate. */
export function chipLabel(t: Pick<TaskSummary, "kind" | "label">): string {
  const base = t.kind === "command" ? t.label.trim().split(/\s+/).slice(0, 2).join(" ") : t.label.trim();
  return base.length > MAX_CHIP_LABEL_CHARS ? `${base.slice(0, MAX_CHIP_LABEL_CHARS - 1)}…` : base;
}

/**
 * Collapsed-chip trailing text: up to 3 entries, then "+N". A running task shows a live `m:ss` clock;
 * a finished one shows its terminal word (`done 38s`, `failed`, ...) because a clock since start is meaningless.
 */
export function chipLabels(tasks: readonly TaskSummary[], now: number): string {
  const shown = tasks.slice(0, MAX_CHIP_LABELS).map((t) => {
    const s = toMs(t.startedAt);
    const tail = t.state === "running" ? (s !== undefined ? formatClock(now - s) : "") : rowMeta(t, now);
    return tail ? `${chipLabel(t)} ${tail}` : chipLabel(t);
  });
  const extra = tasks.length - shown.length;
  return shown.join(" · ") + (extra > 0 ? ` +${extra}` : "");
}

/** Chip / header summary: "2 running", "1 running · 1 quiet", "3 finished", "2 quiet". */
export function summaryText(g: TaskGroups): string {
  const parts: string[] = [];
  if (g.running.length) parts.push(`${g.running.length} running`);
  if (g.quiet.length) parts.push(`${g.quiet.length} quiet`);
  if (!parts.length && g.finished.length) parts.push(`${g.finished.length} finished`);
  return parts.join(" · ");
}

/** View breadcrumb counts, same vocabulary as {@link summaryText}: non-zero parts of running / quiet / finished. */
export function countsText(g: Pick<TaskGroups, "running" | "quiet" | "finished">): string {
  const parts: string[] = [];
  if (g.running.length) parts.push(`${g.running.length} running`);
  if (g.quiet.length) parts.push(`${g.quiet.length} quiet`);
  if (g.finished.length) parts.push(`${g.finished.length} finished`);
  return parts.join(" · ");
}
