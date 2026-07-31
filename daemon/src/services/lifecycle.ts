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
import { hasSession, capturePane } from "./tmux.js";
import { getAllProjects, mutateProject } from "../state/project-store.js";
import { broadcastAll } from "../broadcaster.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { sessionChannel } from "./channel.js";
import type { LifecycleState, SessionRecord } from "../types.js";

export const POLL_INTERVAL_MS = 1000;

/** Pane output must stay byte-identical this long before we flip to idle. */
export const IDLE_THRESHOLD_MS = 4000;

/** Lines captured for idle hashing — compare full window, not only the last line. */
export const CAPTURE_LINES = 20;

type IdleTrack = { hash: string; stableSince: number };
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

export async function persistLifecycleState(
  projectId: string,
  worktreeId: string | undefined,
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

  if (worktreeId) {
    // Worktree session
    await mutateProject(projectId, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktreeId
          ? {
              ...w,
              sessions: w.sessions.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      lifecycle: {
                        state: newState,
                        lastTransitionAt: new Date().toISOString(),
                      },
                    }
                  : s,
              ),
            }
          : w,
      ),
    }));
  } else {
    // Direct session
    await mutateProject(projectId, (p) => ({
      ...p,
      directSessions: p.directSessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              lifecycle: {
                state: newState,
                lastTransitionAt: new Date().toISOString(),
              },
            }
          : s,
      ),
    }));
  }
}

/** Lines of ring buffer used for idle hashing in direct-pty mode. */
const DIRECT_IDLE_BYTES = 4 * 1024;

async function pollSession(
  projectId: string,
  worktreeId: string | undefined,
  session: SessionRecord,
): Promise<void> {
  if (session.lifecycle.state === "not_started") return;

  // JSON channel (Decision 11): turn/queue state is authoritative — there is no
  // tmux pane or direct-pty stream to poll. `JsonAgentSession` drives lifecycle,
  // so skip the TTY heuristics entirely.
  if (sessionChannel(session) === "json") return;

  // Direct-pty exit is event-driven (via DirectPtyStream.onExit → markSessionExited).
  // The poller only handles idle detection for direct-pty sessions that are still alive.
  // session.useTmux is coerced to boolean at loadAll time, but guard against undefined
  // from tests that construct records directly — treat undefined as true (tmux default).
  if (session.useTmux === false) {
    if (session.lifecycle.state === "exited") return;

    const stream = directPtyRegistry.get(session.id);
    if (!stream) {
      // Stream gone but state not yet exited — event-driven path will handle it.
      return;
    }

    // Terminals: skip idle/working churn — they're meaningless for shell sessions.
    if (session.type === "terminal") return;

    if (session.lifecycle.state !== "working" && session.lifecycle.state !== "idle") {
      return;
    }

    // Use tail of ring buffer for idle hashing (equivalent of capturePane for tmux).
    const recentOutput = stream.getRecentOutput?.(DIRECT_IDLE_BYTES) ?? "";
    const newHash = hashPane(recentOutput);
    const now = Date.now();

    const entry = idleTracking.get(session.id);
    if (!entry) {
      idleTracking.set(session.id, { hash: newHash, stableSince: now });
      return;
    }

    if (entry.hash !== newHash) {
      idleTracking.set(session.id, { hash: newHash, stableSince: now });
      if (session.lifecycle.state === "idle") {
        await persistLifecycleState(projectId, worktreeId, session.id, "working");
      }
      return;
    }

    const stableAge = now - entry.stableSince;
    if (stableAge >= IDLE_THRESHOLD_MS && session.lifecycle.state !== "idle") {
      await persistLifecycleState(projectId, worktreeId, session.id, "idle");
    }
    return;
  }

  // Tmux path (existing behavior).
  const alive = await hasSession(session.tmuxName);

  if (!alive && session.lifecycle.state !== "exited" && session.lifecycle.state !== "done") {
    idleTracking.delete(session.id);
    broadcastAll({
      type: "session:exited",
      sessionId: session.id,
    });
    await persistLifecycleState(projectId, worktreeId, session.id, "exited");
    return;
  }

  if (!alive) return;

  // Terminal sessions don't have user-meaningful idle/working states — skip
  // the hash-based detection. They stay "working" until exited (handled above).
  if (session.type === "terminal") return;

  if (session.lifecycle.state !== "working" && session.lifecycle.state !== "idle") {
    return;
  }

  try {
    const output = await capturePane(session.tmuxName, { lines: CAPTURE_LINES });
    const newHash = hashPane(output);
    const now = Date.now();

    let entry = idleTracking.get(session.id);
    if (!entry) {
      idleTracking.set(session.id, { hash: newHash, stableSince: now });
      return;
    }

    if (entry.hash !== newHash) {
      idleTracking.set(session.id, { hash: newHash, stableSince: now });
      if (session.lifecycle.state === "idle") {
        await persistLifecycleState(projectId, worktreeId, session.id, "working");
      }
      return;
    }

    const stableAge = now - entry.stableSince;
    if (stableAge >= IDLE_THRESHOLD_MS && session.lifecycle.state !== "idle") {
      await persistLifecycleState(projectId, worktreeId, session.id, "idle");
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
  const projects = getAllProjects();
  await Promise.all(
    projects.flatMap((project) => [
      // Poll worktree sessions
      ...project.worktrees.flatMap((worktree) =>
        worktree.sessions.map((session) =>
          pollSession(project.id, worktree.id, session).catch((err) => {
            console.error(`[lifecycle] Poll error for ${session.id}:`, err);
          }),
        ),
      ),
      // Poll direct sessions
      ...project.directSessions.map((session) =>
        pollSession(project.id, undefined, session).catch((err) => {
          console.error(`[lifecycle] Poll error for ${session.id}:`, err);
        }),
      ),
    ]),
  );
}

export function startLifecyclePoller(): void {
  if (pollerHandle) return;
  pollerHandle = setInterval(() => {
    void pollAll();
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
