import type { ApiInstance } from "@/api";

/**
 * Session-domain data access, wrapping the session-related subset of
 * `api/client.ts` (via the shared `ApiInstance`). Every method here is the
 * same closure `api` already exposes — this repository adds a domain
 * boundary, not new fetch/parse logic.
 *
 * `on` is the same multiplexed subscribe-by-name function as `api.on` (not
 * reimplemented) — callers register against the session-domain event names
 * (`session:created`, `session:state`, `session:exited`, `session:resumed`,
 * `session:deleted`, `session:updated`, ...).
 */
export function createSessionRepository(api: ApiInstance) {
  return {
    listSessions: api.listSessions,
    createSession: api.createSession,
    createDirectSession: api.createDirectSession,
    nextTerminalName: api.nextTerminalName,
    pinSession: api.pinSession,
    renameSession: api.renameSession,
    reorderSession: api.reorderSession,
    resetSession: api.resetSession,
    handoffSession: api.handoffSession,
    markSessionDone: api.markSessionDone,
    terminateSession: api.terminateSession,
    resumeSession: api.resumeSession,
    delinkSession: api.delinkSession,
    openSession: api.openSession,
    closeSession: api.closeSession,
    sendKeystroke: api.sendKeystroke,
    sendDebug: api.sendDebug,
    resizeSession: api.resizeSession,
    getMeta: api.getMeta,
    on: api.on,
  };
}

export type SessionRepository = ReturnType<typeof createSessionRepository>;
