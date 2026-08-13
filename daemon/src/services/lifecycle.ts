/**
 * Session lifecycle poller.
 *
 * Per HIGH-LEVEL-DESIGN.md §3 and §6:
 * - Polls each session at ~1 Hz
 * - Uses tmux has-session to detect exited sessions
 * - Captures pane output and derives working vs idle from **activity stability**
 * - Persists lifecycle transitions to the manifest when state changes
 *
 * Idle contract (activity-delta):
 * - Hash the last CAPTURE_LINES of pane text each tick (SHA-1).
 * - First observation for a session starts in "working" tracking (no immediate idle flip).
 * - If the hash stays unchanged for IDLE_THRESHOLD_MS → lifecycle **idle**.
 * - If the hash changes → reset stability clock → lifecycle **working**.
 * - Only applies while lifecycle is already **working** or **idle** (never overrides
 *   not_started / done / exited).
 */

import { createHash } from "node:crypto";
import { listSessionNames, capturePane } from "./tmux.js";
import { getAllProjects, updateSessionLifecycle } from "../state/project-store.js";
import { broadcastAll } from "../broadcaster.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { sessionChannel } from "./channel.js";
import type { LifecycleState, SessionRecord } from "../types.js";

export const POLL_INTERVAL_MS = 1000;

/** Pane output must stay byte-identical this long before we flip to idle. */
export const IDLE_THRESHOLD_MS = 4000;

/** Lines captured for idle hashing — compare full window, not only the last line. */
export const CAPTURE_LINES = 20;

type IdleTrack = {
  hash: string;
  stableSince: number;
  /**
   * R3 — true once this session has reached "working" at least once.
   * Seeded `true` the moment this poller starts tracking the session:
   * `pollSession` already returns early for `"not_started"` (see the guard
   * above), and a session only reaches `"working"` after its ready signal
   * has already printed visible content (`getReadySignal()` — a prompt/
   * banner, at minimum) — so "genuinely blank, nothing has happened yet"
   * is not achievable by the time this poller ever captures a pane for a
   * `"working"`/`"idle"`/`"waiting_for_human"` session. R3a's carve-out
   * ("never reached working stays idle") has no live manifestation on this
   * poller specifically.
   *
   * An earlier revision tried a stricter "only true after an OBSERVED hash
   * change" rule, to guard against a hypothetical blank-session false
   * positive — empirically wrong: live-tested against a real fast-completing
   * turn, the whole response printed and stabilized between two 1s poll
   * ticks, so no delta was ever observed and R3 silently never fired. Seed
   * `true` unconditionally instead — both simpler and the only version that
   * actually works given the poller's 1Hz sampling rate.
   *
   * Carried forward across hash resets so it survives for the life of the
   * tracking entry (in-memory only — reset on daemon restart, see plan
   * Research §R3's "ever worked" tracking).
   */
  everWorked: boolean;
};
const idleTracking = new Map<string, IdleTrack>();

let pollerHandle: ReturnType<typeof setInterval> | null = null;

/** Test helper — clears pane-hash tracking. */
export function _resetIdleTrackingForTest(): void {
  idleTracking.clear();
}

/**
 * Clear ONE session's idle-hash tracking entry. Exit paths already do this
 * (below, and `markSessionExited`) so an exited→respawned session starts
 * clean. The one gap: a tty→json toggle kills the tmux window via
 * `killSession` directly (not through the exit-detection path), so the
 * poller's `useTmux === false` branch — session type checks aside, this also
 * covers the tmux case — never gets a chance to delete the entry (it only
 * deletes on a detected EXIT, and this teardown isn't one). A stale entry
 * left behind can then survive into a LATER json→tty toggle: if the new
 * pane's first `CAPTURE_LINES` happen to hash identical to the old session's
 * (plausible — same CLI splash/prompt), `stableAge` is already past
 * `IDLE_THRESHOLD_MS` and the fresh session flips to "idle" one tick after
 * being marked "working". Call this whenever a session's tmux/pty is torn
 * down outside the poller's own exit-detection.
 */
export function clearIdleTracking(sessionId: string): void {
  idleTracking.delete(sessionId);
}

function hashPane(output: string): string {
  return createHash("sha1").update(output, "utf8").digest("hex");
}

/**
 * @param _worktreeId Retained for call-site compatibility only — the row is now
 * located by the DB-wide-unique session id, so the worktree is not needed.
 */
export async function persistLifecycleState(
  projectId: string,
  _worktreeId: string | undefined,
  sessionId: string,
  newState: LifecycleState,
): Promise<void> {
  // Broadcast — every viewer (dashboard, sidebar, etc.) needs lifecycle state,
  // not just the one subscribed to this session's terminal output.
  broadcastAll({
    type: "session:state",
    sessionId,
    state: newState,
  });

  // Single-row UPDATE, not a `mutateProject` read-modify-write. The latter
  // routes through `writeProjectFull`, which DELETEs and re-INSERTs every
  // worktree + session row of the project (~290 statements plus an fsync on a
  // real install) just to change one session's `state`. Lifecycle transitions
  // fire continuously as agents flip working<->idle, so that write
  // amplification was a standing tax on the event loop. `worktreeId` is no
  // longer needed to locate the row — session ids are unique DB-wide.
  await updateSessionLifecycle(projectId, sessionId, {
    state: newState,
    lastTransitionAt: new Date().toISOString(),
  });
}

/** Lines of ring buffer used for idle hashing in direct-pty mode. */
const DIRECT_IDLE_BYTES = 4 * 1024;

async function pollSession(
  projectId: string,
  worktreeId: string | undefined,
  session: SessionRecord,
  /** Names of every tmux session alive right now — see `pollAll`. */
  aliveTmuxNames: ReadonlySet<string>,
): Promise<void> {
  if (session.lifecycle.state === "not_started") return;

  // `done` and `exited` are terminal: whatever the liveness check says, every
  // branch below is a no-op for them (traced: the `!alive` branch excludes
  // both, and the idle/working hash branch requires `working`/`idle`). Bailing
  // here is behaviour-neutral and skips the majority of the work — on a real
  // install 175 of 237 sessions are in one of these two states.
  if (session.lifecycle.state === "done" || session.lifecycle.state === "exited") return;

  // JSON channel (Decision 11): turn/queue state is authoritative — there is no
  // tmux pane or direct-pty stream to poll. `JsonAgentSession` drives lifecycle,
  // so skip the TTY heuristics entirely.
  if (sessionChannel(session) === "json") return;

  // Direct-pty exit is event-driven (via DirectPtyStream.onExit → markSessionExited).
  // The poller only handles idle detection for direct-pty sessions that are still alive.
  // session.useTmux is coerced to boolean at loadAll time, but guard against undefined
  // from tests that construct records directly — treat undefined as true (tmux default).
  if (session.useTmux === false) {
    // (An `exited` check used to live here; the terminal-state early return
    // above already covers it.)
    const stream = directPtyRegistry.get(session.id);
    if (!stream) {
      // Stream gone but state not yet exited — event-driven path will handle it.
      return;
    }

    // Terminals: skip idle/working churn — they're meaningless for shell sessions.
    if (session.type === "terminal") return;

    if (
      session.lifecycle.state !== "working" &&
      session.lifecycle.state !== "idle" &&
      session.lifecycle.state !== "waiting_for_human"
    ) {
      return;
    }

    // Use tail of ring buffer for idle hashing (equivalent of capturePane for tmux).
    const recentOutput = stream.getRecentOutput?.(DIRECT_IDLE_BYTES) ?? "";
    const newHash = hashPane(recentOutput);
    const now = Date.now();

    const entry = idleTracking.get(session.id);
    if (!entry) {
      // A session only reaches "working" after its ready signal has already
      // printed visible content (getReadySignal() — a prompt/banner, at
      // minimum), so by the time this poller ever captures a pane for a
      // "working"/"idle"/"waiting_for_human" session, "genuinely blank,
      // nothing has happened yet" is not achievable — R3a's carve-out has no
      // live manifestation here (see the field's doc comment). Empirically
      // confirmed: requiring an OBSERVED hash change before flagging
      // `everWorked` missed fast-completing turns entirely (the whole
      // response can finish between two 1s poll ticks, so no delta is ever
      // observed) — seeding true immediately is both correct and reliable.
      idleTracking.set(session.id, { hash: newHash, stableSince: now, everWorked: true });
      return;
    }

    if (entry.hash !== newHash) {
      // Pane output changed — resuming from idle/waiting_for_human (a human
      // responded, or the agent started a new turn) is what flips lifecycle
      // back to "working" (R4). `everWorked` is already true from the seed
      // above, so it's just carried forward here, not derived from this event.
      const resuming = session.lifecycle.state === "idle" || session.lifecycle.state === "waiting_for_human";
      idleTracking.set(session.id, {
        hash: newHash,
        stableSince: now,
        everWorked: entry.everWorked,
      });
      if (resuming) {
        await persistLifecycleState(projectId, worktreeId, session.id, "working");
      }
      return;
    }

    const stableAge = now - entry.stableSince;
    if (stableAge >= IDLE_THRESHOLD_MS) {
      // R3: once this session has ever reached "working" (per this poller's
      // own observation), idle-stability lands on "waiting_for_human" instead
      // of "idle" — R3a (never worked) still lands on plain "idle".
      const target: LifecycleState = entry.everWorked ? "waiting_for_human" : "idle";
      if (session.lifecycle.state !== target) {
        await persistLifecycleState(projectId, worktreeId, session.id, target);
      }
    }
    return;
  }

  // Tmux path. Membership in the single per-tick `list-sessions` snapshot,
  // NOT a `tmux has-session` subprocess per session — that was one fork() per
  // session per second (230/s on a real install), and fork() cost scales with
  // the daemon's RSS, so it was consuming over half the event loop.
  const alive = aliveTmuxNames.has(session.tmuxName);

  // The `state !== "exited" && state !== "done"` guard that used to be here is
  // now redundant — the terminal-state early return at the top of this
  // function already excludes both.
  if (!alive) {
    idleTracking.delete(session.id);
    broadcastAll({
      type: "session:exited",
      sessionId: session.id,
    });
    await persistLifecycleState(projectId, worktreeId, session.id, "exited");
    return;
  }

  // Terminal sessions don't have user-meaningful idle/working states — skip
  // the hash-based detection. They stay "working" until exited (handled above).
  if (session.type === "terminal") return;

  if (
    session.lifecycle.state !== "working" &&
    session.lifecycle.state !== "idle" &&
    session.lifecycle.state !== "waiting_for_human"
  ) {
    return;
  }

  try {
    const output = await capturePane(session.tmuxName, { lines: CAPTURE_LINES });
    const newHash = hashPane(output);
    const now = Date.now();

    const entry = idleTracking.get(session.id);
    if (!entry) {
      // A session only reaches "working" after its ready signal has already
      // printed visible content (getReadySignal() — a prompt/banner, at
      // minimum), so by the time this poller ever captures a pane for a
      // "working"/"idle"/"waiting_for_human" session, "genuinely blank,
      // nothing has happened yet" is not achievable — R3a's carve-out has no
      // live manifestation here (see the field's doc comment). Empirically
      // confirmed: requiring an OBSERVED hash change before flagging
      // `everWorked` missed fast-completing turns entirely (the whole
      // response can finish between two 1s poll ticks, so no delta is ever
      // observed) — seeding true immediately is both correct and reliable.
      idleTracking.set(session.id, { hash: newHash, stableSince: now, everWorked: true });
      return;
    }

    if (entry.hash !== newHash) {
      // Pane output changed — resuming from idle/waiting_for_human (a human
      // responded, or the agent started a new turn) is what flips lifecycle
      // back to "working" (R4). `everWorked` is already true from the seed
      // above, so it's just carried forward here, not derived from this event.
      const resuming = session.lifecycle.state === "idle" || session.lifecycle.state === "waiting_for_human";
      idleTracking.set(session.id, {
        hash: newHash,
        stableSince: now,
        everWorked: entry.everWorked,
      });
      if (resuming) {
        await persistLifecycleState(projectId, worktreeId, session.id, "working");
      }
      return;
    }

    const stableAge = now - entry.stableSince;
    if (stableAge >= IDLE_THRESHOLD_MS) {
      // R3: once this session has ever reached "working" (per this poller's
      // own observation), idle-stability lands on "waiting_for_human" instead
      // of "idle" — R3a (never worked) still lands on plain "idle".
      const target: LifecycleState = entry.everWorked ? "waiting_for_human" : "idle";
      if (session.lifecycle.state !== target) {
        await persistLifecycleState(projectId, worktreeId, session.id, target);
      }
    }
  } catch {
    // Capture pane failed — session may have just exited
  }
}

/**
 * Mark a session as exited synchronously. Called from DirectPtyStream.onExit
 * so exit is detected immediately rather than waiting for the next poll tick.
 * Idempotent — no-ops if already exited.
 *
 * @param worktreeId - undefined for direct sessions (session lives in project.directSessions)
 */
export async function markSessionExited(
  projectId: string,
  worktreeId: string | undefined,
  sessionId: string,
): Promise<void> {
  const projects = getAllProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;

  // Find session in either worktree.sessions or project.directSessions
  let session;
  if (worktreeId) {
    session = project.worktrees
      .find((w) => w.id === worktreeId)
      ?.sessions.find((s) => s.id === sessionId);
  } else {
    session = project.directSessions.find((s) => s.id === sessionId);
  }

  // `done` is deliberate and terminal — marking a session done kills its pane
  // on purpose, and the direct-pty `onExit` callback fires right back into
  // here. Without this guard that callback would demote the session to
  // `exited` moments after the user marked it done (and the broadcast would
  // overwrite `done` in every connected client's store).
  if (!session || session.lifecycle.state === "exited" || session.lifecycle.state === "done") {
    return;
  }

  idleTracking.delete(sessionId);
  broadcastAll({ type: "session:exited", sessionId });
  await persistLifecycleState(projectId, worktreeId, sessionId, "exited");
}

/** Exported for deterministic daemon tests (single poll tick). */
export async function runLifecyclePollOnce(): Promise<void> {
  await pollAll();
}

async function pollAll(): Promise<void> {
  // ONE tmux round-trip for the whole tick. `listSessionNames` returns null
  // when tmux failed for a reason OTHER than "no server running" — a transient
  // failure must not be read as "every session died", or a single hiccup would
  // mass-mark hundreds of sessions exited and fire a broadcast + a DB write for
  // each. Skip the tick and try again in a second.
  const aliveTmuxNames = await listSessionNames();
  if (aliveTmuxNames === null) return;

  const projects = getAllProjects();
  await Promise.all(
    projects.flatMap((project) => [
      // Poll worktree sessions
      ...project.worktrees.flatMap((worktree) =>
        worktree.sessions.map((session) =>
          pollSession(project.id, worktree.id, session, aliveTmuxNames).catch((err) => {
            console.error(`[lifecycle] Poll error for ${session.id}:`, err);
          }),
        ),
      ),
      // Poll direct sessions
      ...project.directSessions.map((session) =>
        pollSession(project.id, undefined, session, aliveTmuxNames).catch((err) => {
          console.error(`[lifecycle] Poll error for ${session.id}:`, err);
        }),
      ),
    ]),
  );
}

export function startLifecyclePoller(): void {
  if (pollerHandle) return;
  // Overlap guard: `pollAll` is async but `setInterval` fires regardless of
  // whether the previous tick finished. Without this, a tick that runs long
  // (many sessions, a slow tmux) stacks on the next one and the in-flight work
  // compounds without bound — which is how a merely-expensive tick turns into
  // multi-second event-loop stalls.
  let inFlight = false;
  pollerHandle = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void pollAll().finally(() => {
      inFlight = false;
    });
  }, POLL_INTERVAL_MS);
  if (typeof pollerHandle === "object" && "unref" in pollerHandle) {
    (pollerHandle as { unref(): void }).unref();
  }
}

export function stopLifecyclePoller(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
  idleTracking.clear();
}
