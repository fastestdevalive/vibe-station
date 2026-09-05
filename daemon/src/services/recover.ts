/**
 * Boot-time recovery for sessions stuck at `not_started` after an unclean daemon restart.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hasSession } from "./tmux.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { getAllProjects, mutateProject } from "../state/project-store.js";
import { sessionChannel } from "./channel.js";
import { sessionDataDir, directSessionDataDir } from "./paths.js";
import type { SessionLifecycle, SessionRecord } from "../types.js";

/**
 * `comm` (`/proc/<pid>/stat`'s parenthesized field) names of every process
 * this daemon may mirror into a session's `turn.pids` pidfile — the allowlist
 * `verifyPidIsTurnProcess` checks a recorded PID against before killing it.
 * Kept here (not re-derived from the plugin registry) to avoid this recovery
 * module depending on the whole plugin layer for one string list; update this
 * list if a plugin's spawned binary/adapter comm name changes.
 *
 * ACP migration (Decision 7): under ACP, `turn.pids` mirrors ONE connection
 * PID per session (spawned once, alive across turns) instead of one PID per
 * turn — the sweep's control flow is unchanged, only what it's allowed to
 * kill grows to include the ACP adapter processes:
 *   - claude: legacy one-shot spawn comm is `claude`; the ACP adapter
 *     (`@agentclientprotocol/claude-agent-acp`, a Bun-bundled JS binary)
 *     was empirically observed to report comm `MainThread` (Bun's default
 *     main-thread name), NOT `claude-agent-acp`.
 *   - cursor: legacy one-shot spawn comm is `cursor-agent`; `cursor-agent acp`
 *     is the SAME Bun-bundled binary and was ALSO empirically observed to
 *     report comm `MainThread`.
 *   - opencode: both the legacy one-shot spawn and `opencode acp` report
 *     comm `opencode` — no new entry needed.
 *   - agy: unresolved — Phase 4.1's auth spike was not run this pass; add
 *     agy's ACP adapter comm here once that spike determines it.
 *
 * Known precision gap (documented, not silently papered over): `MainThread`
 * is a generic Bun runtime thread name, not a vibe-station-specific
 * identifier — in principle ANY Bun-based process on the host could share it,
 * which weakens the PID-reuse guard's specificity for exactly the two CLIs
 * that happen to be Bun-bundled. This is the same trade-off the pre-ACP code
 * already had for `cursor-agent`'s own one-shot spawns (its comm was already
 * `MainThread` before this plan, not `cursor-agent`) — this plan does not
 * introduce a NEW gap, it inherits and extends an existing one. A tighter fix
 * (matching `/proc/<pid>/cmdline` against the known script path instead of
 * `comm`) is a reasonable follow-up but out of scope here.
 */
const KNOWN_TURN_BINARIES = new Set(["claude", "cursor-agent", "opencode", "agy", "MainThread"]);

/**
 * Best-effort identity check before killing a pidfile-recorded PID on boot:
 * read `/proc/<pid>/stat`'s `(comm)` field and confirm it's still one of our
 * own CLI binaries. `turn.pids` only ever stores bare PIDs (no start-time or
 * other identity token — see `writePidFile`), and PID reuse after a machine
 * reboot is real on Linux (default `pid_max` wraps well within normal uptime).
 * Without this check, `process.kill(-pid, "SIGKILL")` on a stale entry could
 * hit an unrelated process group that happened to reuse the PID, taking down
 * a totally unrelated process tree. Returns `true` (proceed with the kill)
 * whenever the check is inconclusive — no `/proc` (non-Linux), unreadable
 * entry (process already gone, races harmlessly with the kill itself) — so
 * this narrows the blast radius without weakening the sweep's original
 * best-effort guarantee on platforms/situations where we can't verify.
 */
/** Exported for direct unit testing — see the doc comment above. */
export function verifyPidIsTurnProcess(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `pid (comm) state ppid …` — comm can contain spaces/parens, so read
    // between the FIRST '(' and the LAST ')' rather than naive splitting.
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open === -1 || close === -1 || close <= open) return true; // unparseable — don't block the sweep
    const comm = stat.slice(open + 1, close);
    return KNOWN_TURN_BINARIES.has(comm);
  } catch {
    return true; // no /proc, or pid already gone — inconclusive, proceed (matches prior best-effort behavior)
  }
}

/**
 * Boot-time orphan sweep (Decision 13): a JSON turn child is spawned in its own
 * process group (`detached`) and mirrors its PID to `<dataDir>/turn.pids`. On an
 * unclean daemon restart that child can survive and keep mutating the checkout,
 * so before we recover session state we SIGKILL any recorded-but-orphaned turn
 * process groups and delete the stale pidfiles. Best-effort throughout.
 */
export function sweepOrphanTurnPids(): void {
  for (const project of getAllProjects()) {
    const jsonSessions: string[] = [];
    for (const wt of project.worktrees) {
      for (const s of wt.sessions) {
        if (sessionChannel(s) === "json") {
          jsonSessions.push(join(sessionDataDir(project.id, wt.id, s.id), "turn.pids"));
        }
      }
    }
    for (const s of project.directSessions) {
      if (sessionChannel(s) === "json") {
        jsonSessions.push(join(directSessionDataDir(project.id, s.id), "turn.pids"));
      }
    }
    for (const pidFile of jsonSessions) {
      if (!existsSync(pidFile)) continue;
      try {
        for (const line of readFileSync(pidFile, "utf8").split("\n")) {
          const pid = Number(line.trim());
          if (!Number.isFinite(pid) || pid <= 1) continue;
          if (!verifyPidIsTurnProcess(pid)) continue; // PID reuse guard — see doc comment above
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already dead */
          }
        }
        unlinkSync(pidFile);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * JSON-channel boot reconciliation (Decision 11): per-turn spawn means no live
 * process survives a daemon restart. A fresh `not_started` JSON session is
 * normal (it has no direct-pty stream) and must NOT be marked `exited`; a
 * session left `working` had its turn killed by the restart → reconcile to
 * `idle`. Returns a decision, or null to leave the state untouched.
 */
function recoverJsonSession(session: SessionRecord): SessionLifecycle | null {
  if (session.lifecycle.state === "working") {
    return {
      state: "idle",
      reason: "json-restart-reconcile",
      lastTransitionAt: new Date().toISOString(),
    };
  }
  // not_started (normal, no stream) / idle / done / exited → leave as-is.
  return null;
}

/**
 * Boot sweep (runs AFTER recoverNotStartedSessions): a direct-pty PTY is a child
 * of the daemon process, so it dies on daemon restart and cannot be recovered —
 * mark any non-exited direct-pty worktree session `exited`.
 *
 * JSON sessions are SKIPPED (Decision 11): they have no direct-pty stream
 * (per-turn spawn, nothing survives a restart) and were already reconciled to
 * `idle` by recoverNotStartedSessions. Without this guard the sweep would clobber
 * that back to `exited` on every boot.
 */
export async function sweepDirectPtySessionsOnBoot(): Promise<void> {
  for (const project of getAllProjects()) {
    const decisions = new Map<string, SessionLifecycle>();
    const directDecisions = new Map<string, SessionLifecycle>();
    for (const wt of project.worktrees) {
      for (const session of wt.sessions) {
        if (sessionChannel(session) === "json") continue;
        if (!session.useTmux && session.lifecycle.state !== "exited") {
          console.log(`[sweep] ${session.id}: direct-pty died with daemon → mark exited`);
          decisions.set(session.id, {
            state: "exited",
            reason: "direct-pty-died-with-daemon",
            lastTransitionAt: new Date().toISOString(),
          });
        }
      }
    }
    // Direct sessions (no worktree) — their PTYs are daemon children too.
    for (const session of project.directSessions) {
      if (sessionChannel(session) === "json") continue;
      if (!session.useTmux && session.lifecycle.state !== "exited") {
        console.log(`[sweep] ${session.id}: direct-pty died with daemon → mark exited`);
        directDecisions.set(session.id, {
          state: "exited",
          reason: "direct-pty-died-with-daemon",
          lastTransitionAt: new Date().toISOString(),
        });
      }
    }
    if (decisions.size === 0 && directDecisions.size === 0) continue;
    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) => ({
        ...w,
        sessions: w.sessions.map((s) => {
          const next = decisions.get(s.id);
          return next ? { ...s, lifecycle: next } : s;
        }),
      })),
      directSessions: p.directSessions.map((s) => {
        const next = directDecisions.get(s.id);
        return next ? { ...s, lifecycle: next } : s;
      }),
    }));
  }
}

export async function recoverNotStartedSessions(): Promise<void> {
  // Kill orphaned JSON turn processes left running by an unclean restart first,
  // then reconcile session lifecycle state.
  sweepOrphanTurnPids();

  for (const project of getAllProjects()) {
    const worktreeDecisions = new Map<string, SessionLifecycle>();
    const directDecisions = new Map<string, SessionLifecycle>();

    // Recover worktree sessions
    for (const wt of project.worktrees) {
      for (const session of wt.sessions) {
        if (sessionChannel(session) === "json") {
          const decision = recoverJsonSession(session);
          if (decision) {
            console.log(`[recover] ${session.id}: json ${session.lifecycle.state} → ${decision.state}`);
            worktreeDecisions.set(session.id, decision);
          }
          continue;
        }

        if (session.lifecycle.state !== "not_started") continue;

        if (session.useTmux === false) {
          // Direct-pty sessions can't survive a daemon restart.
          // The registry will be empty on boot, so treat as exited.
          const alive = directPtyRegistry.has(session.id);
          if (alive) {
            console.log(`[recover] ${session.id}: direct-pty stream alive → promote to working`);
            worktreeDecisions.set(session.id, {
              state: "working",
              reason: "recovered-from-not-started",
              lastTransitionAt: new Date().toISOString(),
            });
          } else {
            console.log(`[recover] ${session.id}: direct-pty not found → mark exited`);
            worktreeDecisions.set(session.id, {
              state: "exited",
              reason: "daemon-restart-during-spawn",
              lastTransitionAt: new Date().toISOString(),
            });
          }
          continue;
        }

        const alive = await hasSession(session.tmuxName);
        if (alive) {
          console.log(`[recover] ${session.id}: tmux pane alive → promote to working`);
          worktreeDecisions.set(session.id, {
            state: "working",
            reason: "recovered-from-not-started",
            lastTransitionAt: new Date().toISOString(),
          });
        } else {
          console.log(`[recover] ${session.id}: tmux pane missing → mark exited`);
          worktreeDecisions.set(session.id, {
            state: "exited",
            reason: "daemon-restart-during-spawn",
            lastTransitionAt: new Date().toISOString(),
          });
        }
      }
    }

    // Recover direct sessions
    for (const session of project.directSessions) {
      if (sessionChannel(session) === "json") {
        const decision = recoverJsonSession(session);
        if (decision) {
          console.log(`[recover] ${session.id}: json ${session.lifecycle.state} → ${decision.state}`);
          directDecisions.set(session.id, decision);
        }
        continue;
      }

      if (session.lifecycle.state !== "not_started") continue;

      if (session.useTmux === false) {
        const alive = directPtyRegistry.has(session.id);
        if (alive) {
          console.log(`[recover] ${session.id}: direct-pty stream alive → promote to working`);
          directDecisions.set(session.id, {
            state: "working",
            reason: "recovered-from-not-started",
            lastTransitionAt: new Date().toISOString(),
          });
        } else {
          console.log(`[recover] ${session.id}: direct-pty not found → mark exited`);
          directDecisions.set(session.id, {
            state: "exited",
            reason: "daemon-restart-during-spawn",
            lastTransitionAt: new Date().toISOString(),
          });
        }
        continue;
      }

      const alive = await hasSession(session.tmuxName);
      if (alive) {
        console.log(`[recover] ${session.id}: tmux pane alive → promote to working`);
        directDecisions.set(session.id, {
          state: "working",
          reason: "recovered-from-not-started",
          lastTransitionAt: new Date().toISOString(),
        });
      } else {
        console.log(`[recover] ${session.id}: tmux pane missing → mark exited`);
        directDecisions.set(session.id, {
          state: "exited",
          reason: "daemon-restart-during-spawn",
          lastTransitionAt: new Date().toISOString(),
        });
      }
    }

    if (worktreeDecisions.size === 0 && directDecisions.size === 0) continue;

    await mutateProject(project.id, (p) => ({
      ...p,
      worktrees: p.worktrees.map((w) => ({
        ...w,
        sessions: w.sessions.map((s) => {
          const next = worktreeDecisions.get(s.id);
          return next ? { ...s, lifecycle: next } : s;
        }),
      })),
      directSessions: p.directSessions.map((s) => {
        const next = directDecisions.get(s.id);
        return next ? { ...s, lifecycle: next } : s;
      }),
    }));
  }
}
