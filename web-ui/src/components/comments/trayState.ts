import type { CommentRestoreReason, ReviewComment, TerminalDelivery } from "@/api/types";
import { restoredGroups, type RestoredGroup } from "./commentSelectors";
import {
  RICH_SEND_MAX_BYTES,
  RICH_SEND_MAX_COMMENTS,
  TERMINAL_SEND_MAX_BYTES,
  blockBytes,
} from "./reviewLimits";
import type { CommentScopeState } from "./useCommentStore";

/** Tray notice copy for why comments came back (`Send` board B, "restored · <reason>"). */
export const RESTORED_COPY: Record<CommentRestoreReason, string> = {
  turn_cancelled: "queued turn cancelled",
  send_failed: "send failed",
  timed_out: "timed out",
  agent_exited: "agent exited",
  restart: "last send didn't finish",
  session_removed: "agent removed",
  channel_changed: "agent switched channel",
  schedule_cancelled: "schedule cancelled",
  schedule_failed: "schedule failed",
  send_cancelled: "send cancelled",
};

export type TrayPrimary =
  /** Nothing to show: no comments and no delivery outcome. */
  | { kind: "hidden" }
  /** A Terminal send is in flight (`waiting` until ready, then `pasting`). */
  | { kind: "sending"; delivery: TerminalDelivery; phase: "waiting" | "pasting"; canCancel: boolean }
  /** A Terminal send finished badly; the comments are back in the panel. */
  | { kind: "timed_out"; delivery: TerminalDelivery }
  | { kind: "agent_exited"; delivery: TerminalDelivery }
  /** Comments returned to the panel (cancelled turn, restart, ...); `Dismiss` clears the notice. */
  | { kind: "restored"; groups: RestoredGroup[]; count: number }
  /** Over the Rich Chat / Terminal send limit: Send disabled, Copy still works. */
  | { kind: "over_limit"; count: number; bytes: number; overBytes: number; overComments: number }
  /** Some comments are attached to a composer ("4 attached to main"). */
  | { kind: "attached"; count: number; composerKeys: string[] }
  | { kind: "normal" };

export interface TrayState {
  primary: TrayPrimary;
  /** Comments in the panel (attached ones included). */
  count: number;
  unsentCount: number;
  attachedCount: number;
  /** Per-file chips, in first-seen order (`+N more` is the tray's job). */
  files: Array<{ path: string; count: number }>;
  /** Offline / reconnecting: Add, Send and Copy are disabled with a reason. */
  offline: boolean;
  /** Send to agent… is allowed (some comment is unattached, under the limits, online). */
  canSend: boolean;
}

export interface TrayInput {
  scope: CommentScopeState | undefined;
  /** Daemon connection is up. */
  online: boolean;
}

const live = (d: TerminalDelivery) => d.state === "waiting" || d.state === "pasting";

/** The newest delivery matching `pred`. */
function newest(deliveries: TerminalDelivery[], pred: (d: TerminalDelivery) => boolean): TerminalDelivery | undefined {
  return deliveries.filter(pred).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}

/**
 * Derive the tray's one primary state from the scope (priority: sending, a failed send, restored notice, over
 * limit, attached, normal). Pure; the tray component (Phase 6) renders it, tests drive it directly.
 */
export function deriveTrayState({ scope, online }: TrayInput): TrayState {
  const comments: ReviewComment[] = scope?.comments ?? [];
  const deliveries = Object.values(scope?.deliveries ?? {});
  const unsent = comments.filter((c) => !c.attachedTo);
  const attached = comments.filter((c) => c.attachedTo);
  const files: TrayState["files"] = [];
  for (const c of comments) {
    const f = files.find((x) => x.path === c.path);
    if (f) f.count += 1;
    else files.push({ path: c.path, count: 1 });
  }

  let primary: TrayPrimary = { kind: "hidden" };
  const sending = newest(deliveries, live);
  const failed = newest(deliveries, (d) => d.state === "timed_out" || (d.state === "failed" && d.reason === "agent_exited"));
  const groups = restoredGroups(comments);
  const bytes = blockBytes(unsent, "");
  const overComments = Math.max(0, unsent.length - RICH_SEND_MAX_COMMENTS);
  // Over the Rich Chat limit only; a Terminal target's 32 KB is judged per row in the picker.
  const overBytes = Math.max(0, bytes - RICH_SEND_MAX_BYTES);

  if (sending) {
    const phase = sending.state === "pasting" ? "pasting" : "waiting";
    primary = { kind: "sending", delivery: sending, phase, canCancel: phase === "waiting" };
  } else if (failed) {
    primary = failed.state === "timed_out" ? { kind: "timed_out", delivery: failed } : { kind: "agent_exited", delivery: failed };
  } else if (groups.length > 0) {
    primary = { kind: "restored", groups, count: groups.reduce((n, g) => n + g.ids.length, 0) };
  } else if (overComments > 0 || overBytes > 0) {
    primary = { kind: "over_limit", count: unsent.length, bytes, overBytes, overComments };
  } else if (attached.length > 0) {
    primary = { kind: "attached", count: attached.length, composerKeys: [...new Set(attached.map((c) => c.attachedTo!))] };
  } else if (comments.length > 0) {
    primary = { kind: "normal" };
  }

  const tooBig = overComments > 0 || overBytes > 0;
  return {
    primary,
    count: comments.length,
    unsentCount: unsent.length,
    attachedCount: attached.length,
    files,
    offline: !online,
    canSend: online && unsent.length > 0 && !tooBig,
  };
}

export const TERMINAL_LIMIT_BYTES = TERMINAL_SEND_MAX_BYTES;
