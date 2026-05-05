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
import { notifySession } from "../broadcaster.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
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

function hashPane(output: string): string {
  return createHash("sha1").update(output, "utf8").digest("hex");
}

export async function persistLifecycleState(
  projectId: string,
  worktreeId: string,
  sessionId: string,
  newState: LifecycleState,
): Promise<void> {
  notifySession(sessionId, {
    type: "session:state",
    sessionId,
    state: newState,
  });
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
}

/** Lines of ring buffer used for idle hashing in direct-pty mode. */
const DIRECT_IDLE_BYTES = 4 * 1024;

async function pollSession(
  projectId: string,
  worktreeId: string,
  session: SessionRecord,
): Promise<void> {
  if (session.lifecycle.state === "not_started") return;

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

  if (!alive && session.lifecycle.state !== "exited") {
    idleTracking.delete(session.id);
    notifySession(session.id, {
      type: "session:exited",
      sessionId: session.id,
    });
    await mutateProject(projectId, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.id === worktreeId
          ? {
              ...w,
              sessions: w.sessions.map((s) =>
                s.id === session.id
                  ? {
                      ...s,
                      lifecycle: {
                        state: "exited",
                        lastTransitionAt: new Date().toISOString(),
                      },
                    }
                  : s,
              ),
            }
          : w,
      ),
    }));
    return;
  }

  if (!alive) return;

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
 */
export async function markSessionExited(
  projectId: string,
  worktreeId: string,
  sessionId: string,
): Promise<void> {
  const projects = getAllProjects();
  const project = projects.find((p) => p.id === projectId);
  const session = project?.worktrees
    .find((w) => w.id === worktreeId)
    ?.sessions.find((s) => s.id === sessionId);

  if (!session || session.lifecycle.state === "exited") return;

  idleTracking.delete(sessionId);
  notifySession(sessionId, { type: "session:exited", sessionId });
  await persistLifecycleState(projectId, worktreeId, sessionId, "exited");
}

/** Exported for deterministic daemon tests (single poll tick). */
export async function runLifecyclePollOnce(): Promise<void> {
  await pollAll();
}

async function pollAll(): Promise<void> {
  const projects = getAllProjects();
  await Promise.all(
    projects.flatMap((project) =>
      project.worktrees.flatMap((worktree) =>
        worktree.sessions.map((session) =>
          pollSession(project.id, worktree.id, session).catch((err) => {
            console.error(`[lifecycle] Poll error for ${session.id}:`, err);
          }),
        ),
      ),
    ),
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
