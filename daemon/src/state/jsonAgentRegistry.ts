/**
 * Registry of live JSON agent-chat sessions.
 *
 * Mirror of `directPtyRegistry`: `sessionId → JsonAgentSession`. A JSON session
 * is registered lazily on its first turn (per-turn spawn is stateless between
 * turns, Decision 2) and removed when the session/worktree is deleted.
 *
 * Typed loosely (`unknown`-free) to avoid an import cycle with the service that
 * defines `JsonAgentSession`; callers import the concrete type from
 * `services/jsonAgent.ts` and cast if they need methods.
 */

import type { JsonAgentSession } from "../services/jsonAgent.js";

export const jsonAgentRegistry = new Map<string, JsonAgentSession>();
