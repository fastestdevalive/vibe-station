/**
 * Handoff turn (Decision 2/6) — asks the outgoing agent to write a summary of
 * its current state before `POST /sessions/:id/reset --handoff` retires it.
 * Bounded by a timeout: a stuck/unresponsive agent must never block a reset,
 * so on timeout or any delivery failure this resolves `false` and the caller
 * proceeds without notes.
 *
 * Split into its own module (not inlined in the reset route) specifically so
 * tests can `vi.mock` it — waiting out a real 60s timeout in a test would be
 * both slow and not actually exercise anything interesting.
 */
import { existsSync } from "node:fs";
import { readFile, unlink, stat } from "node:fs/promises";
import type { SessionRecord } from "../types.js";
import { pasteBuffer } from "./tmux.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { sessionChannel } from "./channel.js";

/**
 * How fresh `.vibe-station/HANDOFF.md` must be for `readFreshHandoffFileOrNull`
 * to accept it as "the agent just wrote this for the reset currently in
 * flight", rather than a stale leftover from an earlier, unrelated handoff.
 * Generous enough to cover a slow file write + CLI invocation in the same
 * turn (the `/vst reset --handoff` self-write path), narrow enough that an
 * old file from minutes ago is never mistaken for a fresh one.
 */
export const HANDOFF_FRESHNESS_MS = 30_000;

const HANDOFF_INSTRUCTION =
  "Before this session ends, write a concise handoff summary of the current " +
  "state, remaining work, and anything the next session should know to " +
  "`.vibe-station/HANDOFF.md` in the working directory, then reply once done.";

export interface RunHandoffTurnOpts {
  timeoutMs: number;
  /** Absolute path to `.vibe-station/HANDOFF.md` this turn is expected to produce. */
  handoffPath: string;
  /** Poll interval while waiting for the file to appear (test override). */
  pollMs?: number;
}

/**
 * Deliver the handoff instruction to the session's live agent, then poll
 * (bounded by `opts.timeoutMs`) for `opts.handoffPath` to appear. Returns
 * `true` once the file shows up, `false` on timeout or delivery failure.
 *
 * JSON-channel turns are intentionally NOT driven through the turn queue here
 * — enqueueing would make this depend on the queue draining asynchronously
 * with no clean "turn finished" signal available to this function without a
 * deeper hook into JsonAgentSession. Polling the filesystem for the artifact
 * the instruction asks for is simpler, harness-agnostic, and matches exactly
 * what the caller actually needs to know (Decision 6 — proceed either way).
 */
export async function runHandoffTurn(session: SessionRecord, opts: RunHandoffTurnOpts): Promise<boolean> {
  // Bug 2 fix: json-channel delivery is a documented no-op — don't waste the full timeout polling for a file nothing will produce.
  if (sessionChannel(session) === "json") return false;

  // Bug 1 fix: a stale HANDOFF.md from a prior handoff/reset must not be mistaken for a fresh one.
  try {
    await unlink(opts.handoffPath);
  } catch {
    // ENOENT is the expected case (no prior file) — anything else is still non-fatal, we proceed either way.
  }

  // The json-channel branch above already returns before this point, so the
  // remaining two delivery paths (tmux / direct-pty) are exhaustive — no
  // third branch to preserve, safe to collapse the old `else if` to `else`.
  try {
    if (session.useTmux) {
      await pasteBuffer(session.tmuxName, `_vst_handoff-${session.id}`, `${HANDOFF_INSTRUCTION}\n`);
    } else {
      directPtyRegistry.get(session.id)?.write?.(`${HANDOFF_INSTRUCTION}\r`);
    }
  } catch {
    return false; // Could not even deliver the instruction — nothing to wait for.
  }

  const pollMs = opts.pollMs ?? 1000;
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    if (existsSync(opts.handoffPath)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return existsSync(opts.handoffPath);
}

export async function readHandoffFileOrNull(path: string): Promise<string | null> {
  try {
    const content = (await readFile(path, "utf8")).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Bug 6 fix: read `.vibe-station/HANDOFF.md` ONLY if it exists and was
 * modified within the last `maxAgeMs` — otherwise returns `null` exactly like
 * a missing file. Lets the reset route opportunistically pick up a handoff
 * the agent wrote itself (the `/vst reset --handoff` self-write path) without
 * running the paste+poll mechanism at all, while ignoring an old file left
 * over from some earlier, unrelated handoff/reset.
 */
export async function readFreshHandoffFileOrNull(path: string, maxAgeMs: number): Promise<string | null> {
  try {
    const stats = await stat(path);
    if (Date.now() - stats.mtimeMs > maxAgeMs) return null;
    const content = (await readFile(path, "utf8")).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}
