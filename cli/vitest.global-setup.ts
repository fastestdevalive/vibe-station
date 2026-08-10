/**
 * Belt-and-suspenders safety net against real tmux session leaks from the
 * test suite (see daemon/src/__tests__/sessions.reset.test.ts,
 * sessions.handoff.test.ts, sessions.reorder.test.ts for the actual fixes).
 *
 * Individual tests should mock `daemon/src/services/tmux.js` so they never
 * touch a real tmux server at all. This global hook is a defense-in-depth
 * fallback for whatever we haven't caught yet: it snapshots the tmux session
 * list before the run and diffs against the snapshot after the run, killing
 * only sessions that appeared DURING this test run.
 *
 * This is deliberately a diff, not a name-pattern sweep — a pattern-based
 * sweep of e.g. `vst-*` would be unsafe on a dev host that also runs a real
 * vst daemon (which names its own real sessions `vst-<id>`) or other tools.
 * Diffing against a snapshot never touches a pre-existing session, real or
 * otherwise.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

async function listSessionNames(): Promise<Set<string>> {
  try {
    const { stdout } = await execFile("tmux", ["list-sessions", "-F", "#{session_name}"]);
    return new Set(stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    // No tmux server running (or tmux not installed) — nothing to snapshot.
    return new Set();
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const before = await listSessionNames();

  return async function teardown(): Promise<void> {
    const after = await listSessionNames();
    const leaked = [...after].filter((name) => !before.has(name));
    if (leaked.length === 0) return;

    console.warn(
      `[vitest globalTeardown] Killing ${leaked.length} tmux session(s) leaked by the test run: ${leaked.join(", ")}`,
    );
    await Promise.all(
      leaked.map((name) => execFile("tmux", ["kill-session", "-t", name]).catch(() => {})),
    );
  };
}
