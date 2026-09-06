import type { ApiInstance } from "@/api";

/**
 * Chat/message-domain data access, wrapping the chat-related subset of
 * `api/client.ts` (via the shared `ApiInstance`). Every method here is the
 * same closure `api` already exposes — this repository adds a domain
 * boundary, not new fetch/parse logic.
 *
 * `on` is the same multiplexed subscribe-by-name function as `api.on` (not
 * reimplemented) — callers register against the chat-domain event names
 * (`chat:replay`, `session:message`, `session:meta`, `session:error`,
 * `session:fork`, ...) — chat-turn-scoped despite the `session:` prefix on
 * some of them.
 */
export function createChatRepository(api: ApiInstance) {
  return {
    openChat: api.openChat,
    closeChat: api.closeChat,
    sendChat: api.sendChat,
    stopChat: api.stopChat,
    cancelQueuedTurn: api.cancelQueuedTurn,
    beginEditQueuedTurn: api.beginEditQueuedTurn,
    resubmitQueuedTurn: api.resubmitQueuedTurn,
    promoteQueuedTurn: api.promoteQueuedTurn,
    forkChat: api.forkChat,
    setSessionModel: api.setSessionModel,
    setSessionChannel: api.setSessionChannel,
    uploadAttachments: api.uploadAttachments,
    deleteAttachment: api.deleteAttachment,
    getTranscript: api.getTranscript,
    getTranscriptPage: api.getTranscriptPage,
    getTranscriptAll: api.getTranscriptAll,
    on: api.on,
  };
}

export type ChatRepository = ReturnType<typeof createChatRepository>;
