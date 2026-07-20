/**
 * Execution-channel resolution (Decision 1).
 *
 * `channel` is the single source of truth for how a session runs: `tmux`/`pty`
 * (TTY, existing `useTmux` split) or `json` (structured JSON agent chat). Route
 * every backend branch through `sessionChannel(session)` instead of reading
 * `session.useTmux` directly, so a third mode never has to be a third boolean.
 *
 * Back-compat: legacy manifests have no `channel`; derive it from `useTmux`.
 */

import { resolveUseTmux } from "./resolveUseTmux.js";
import type { Channel } from "../types.js";

/**
 * Resolve a channel from create-time inputs.
 * `json` wins (and pins `useTmux=false` at the call site); otherwise fall back
 * to the tmux/pty split.
 */
export function resolveChannel(useTmux: boolean, json = false): Channel {
  if (json) return "json";
  return useTmux ? "tmux" : "pty";
}

/**
 * Single source of truth for a session's channel.
 * Prefers an explicit `channel`; otherwise derives from `useTmux`
 * (coercing legacy `undefined` → `true` → `"tmux"`).
 */
export function sessionChannel(session: { channel?: Channel; useTmux?: boolean }): Channel {
  if (session.channel) return session.channel;
  return resolveUseTmux(session.useTmux) ? "tmux" : "pty";
}

/** True when the session is a JSON agent-chat session. */
export function isJsonChannel(session: { channel?: Channel; useTmux?: boolean }): boolean {
  return sessionChannel(session) === "json";
}

/**
 * Normalize a session record in place: stamp a concrete `channel` and enforce
 * the JSON invariant (`channel: "json"` ⇒ `useTmux: false`). Called on manifest
 * load (backfill) and after create so downstream code never sees an ambiguous
 * record. Mutates and returns the same object for convenience.
 */
export function normalizeChannel<T extends { channel?: Channel; useTmux?: boolean }>(session: T): T {
  const channel = sessionChannel(session);
  session.channel = channel;
  if (channel === "json") {
    session.useTmux = false;
  }
  return session;
}

/**
 * Compute the `{channel, useTmux}` fields for a live channel toggle (P3, R1.2).
 * Preserves the same invariant as `normalizeChannel` for the JSON case and pins
 * the tmux/pty split for TTY targets: `tmux ⇒ useTmux:true`, `pty`/`json ⇒
 * `useTmux:false`.
 */
export function channelTransition(target: Channel): { channel: Channel; useTmux: boolean } {
  return { channel: target, useTmux: target === "tmux" };
}
