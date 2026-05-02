/**
 * Session lifecycle poller.
 *
 * Per HIGH-LEVEL-DESIGN.md §3 and §6:
 * - Polls each session at ~1 Hz
 * - Uses tmux has-session to detect exited sessions
 * - Captures pane output and runs plugin's detectActivity (if available)
 * - Debounces state-only disk writes at 500ms per project
 * - Only writes if state actually changed (no-op on no change)
 */

import { hasSession, capturePane } from "./tmux.js";
import { writeManifest } from "./manifest.js";
import { getAllProjects, getProject, mutateProject } from "../state/project-store.js";
import { notifySession } from "../broadcaster.js";
import type { LifecycleState, SessionRecord } from "../types.js";

const POLL_INTERVAL_MS = 1000;
const DEBOUNCE_MS = 500;

// Per-project debounce timers
const debouncers = new Map<string, ReturnType<typeof setTimeout>>();

// Track dirty projects
const dirtyProjects = new Set<string>();

let pollerHandle: ReturnType<typeof setInterval> | null = null;

function scheduleDiskFlush(projectId: string): void {
  const existing = debouncers.get(projectId);
  if (existing) clearTimeout(existing);

  debouncers.set(
    projectId,
    setTimeout(() => {
      debouncers.delete(projectId);
      dirtyProjects.delete(projectId);
      // Re-read from store and flush
      const project = getProject(projectId);
      if (project) {
        writeManifest(project).catch((err) => {
          console.error(`[lifecycle] Failed to flush manifest for ${projectId}:`, err);
        });
      }
    }, DEBOUNCE_MS),
  );
}

async function pollSession(
  projectId: string,
  worktreeId: string,
  session: SessionRecord,
): Promise<void> {
  // Skip non-active sessions
  if (session.lifecycle.state === "not_started") return;

  const alive = await hasSession(session.tmuxName);

  if (!alive && session.lifecycle.state !== "exited") {
    // Session exited — broadcast to live subscribers AND persist to manifest
    // so a page reload doesn't show a "working" session for a dead pane.
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

  if (!alive) return; // already exited, no change

  // Capture pane to detect activity
  try {
    const output = await capturePane(session.tmuxName, { lines: 20 });
    // Basic heuristic: if output ends with a prompt-like pattern, consider idle
    const isIdle = /[>\$#]\s*$/.test(output.trimEnd());
    const newState: LifecycleState = isIdle ? "idle" : "working";

    if (newState !== session.lifecycle.state) {
      // State changed — emit WS event
      notifySession(session.id, {
        type: "session:state",
        sessionId: session.id,
        state: newState,
      });
      dirtyProjects.add(projectId);
      scheduleDiskFlush(projectId);
    }
  } catch {
    // Capture pane failed — session may have just exited
  }
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
  // Unref so the timer doesn't keep the process alive if nothing else is running
  if (typeof pollerHandle === "object" && "unref" in pollerHandle) {
    (pollerHandle as { unref(): void }).unref();
  }
}

export function stopLifecyclePoller(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
  for (const t of debouncers.values()) clearTimeout(t);
  debouncers.clear();
  dirtyProjects.clear();
}
